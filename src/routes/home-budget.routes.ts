import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from '../lib/period.js'

const router = Router()
router.use(authMiddleware)

/** Frontera Q1/Q2 de una obligación quincenal: usa sus PROPIOS días de cobro
 * (`diasPago`/`fechaCorte`), no los del sueldo del usuario — ver debts.routes.ts. */
function itemPeriodo(frecuencia: string, ownDays: string): string {
  if (frecuencia !== 'quincenal') return getPeriodo(frecuencia)
  return getPeriodo('quincenal', parseDiasPago(ownDays))
}

/** Suma las obligaciones (deudas + gastos fijos) que siguen PENDIENTES en el
 * periodo actual de cada una — "pendiente" ya no es una columna, se deriva
 * comparando lo pagado en el periodo (ledger) contra lo que corresponde. */
async function pendingObligationsTotal(userId: string): Promise<number> {
  const [debts, fixedExpenses] = await Promise.all([
    prisma.debt.findMany({ where: { userId, estado: 'activa' } }),
    prisma.fixedExpense.findMany({ where: { userId } }),
  ])
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  const [debtPayments, fixedPayments] = await Promise.all([
    debts.length > 0
      ? prisma.debtPayment.findMany({ where: { debtId: { in: debts.map(d => d.id) }, createdAt: { gte: fortyDaysAgo } } })
      : Promise.resolve([]),
    fixedExpenses.length > 0
      ? prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: { in: fixedExpenses.map(f => f.id) }, createdAt: { gte: fortyDaysAgo } } })
      : Promise.resolve([]),
  ])

  let total = 0
  for (const d of debts) {
    const periodo = itemPeriodo(d.frecuenciaPago === 'quincenal' ? 'quincenal' : 'mensual', d.diasPago)
    const paid = debtPayments.filter(p => p.debtId === d.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
    if (paid < Number(d.cuotaPeriodo)) total += Number(d.cuotaPeriodo)
  }
  for (const f of fixedExpenses) {
    const periodo = itemPeriodo(f.frecuencia, f.fechaCorte)
    const montoPorPeriodo = getMontoPorPeriodo(Number(f.monto), f.frecuencia)
    const paid = fixedPayments.filter(p => p.fixedExpenseId === f.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
    if (paid < montoPorPeriodo) total += Number(f.monto)
  }
  return total
}

// ═══════════════════════════════════════════════════════════════════════════════
// calculateHomeBudget — Presupuesto unificado de pareja
// ═══════════════════════════════════════════════════════════════════════════════
//
// Combina los ingresos de ambos usuarios (PARTNER) y calcula la distribución
// del presupuesto del hogar usando el mismo algoritmo de Kiri:
//   1. Obligaciones (suma de deudas + gastos fijos de ambos)
//   2. Ahorro (escala según remanente)
//   3. Gasto Libre (tope 15%)
//   4. Capacidad de Endeudamiento (residual)

export interface HomeBudgetResult {
  ingresoTotal: number
  ingresoUser1: number
  ingresoUser2: number
  obligacionesTotal: number
  obligacionesUser1: number
  obligacionesUser2: number
  ahorro: number
  ahorroPct: number
  libre: number
  librePct: number
  capacidadEndeudamiento: number
  capacidadPct: number
  obligacionesPct: number
  isOverloaded: boolean
}

export async function calculateHomeBudget(userId1: string, userId2: string): Promise<HomeBudgetResult> {
  // Obtener ingresos de ambos usuarios
  const [user1, user2] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId1 }, select: { ingresoBase: true, frecuenciaIngreso: true } }),
    prisma.user.findUnique({ where: { id: userId2 }, select: { ingresoBase: true, frecuenciaIngreso: true } }),
  ])

  const ingreso1 = Number(user1?.ingresoBase ?? 0)
  const ingreso2 = Number(user2?.ingresoBase ?? 0)
  const ingresoTotal = ingreso1 + ingreso2

  if (ingresoTotal <= 0) {
    return {
      ingresoTotal: 0, ingresoUser1: 0, ingresoUser2: 0,
      obligacionesTotal: 0, obligacionesUser1: 0, obligacionesUser2: 0,
      ahorro: 0, ahorroPct: 0, libre: 0, librePct: 0,
      capacidadEndeudamiento: 0, capacidadPct: 0, obligacionesPct: 0,
      isOverloaded: false,
    }
  }

  // Obtener obligaciones pendientes de ambos (derivado del ledger de pagos)
  const [oblig1, oblig2] = await Promise.all([
    pendingObligationsTotal(userId1),
    pendingObligationsTotal(userId2),
  ])
  const obligacionesTotal = oblig1 + oblig2

  // Calcular distribución del hogar
  const obligacionesPct = (obligacionesTotal / ingresoTotal) * 100
  const remanente = Math.max(0, ingresoTotal - obligacionesTotal)
  const isOverloaded = obligacionesTotal >= ingresoTotal

  if (isOverloaded) {
    return {
      ingresoTotal, ingresoUser1: ingreso1, ingresoUser2: ingreso2,
      obligacionesTotal, obligacionesUser1: oblig1, obligacionesUser2: oblig2,
      ahorro: 0, ahorroPct: 0, libre: 0, librePct: 0,
      capacidadEndeudamiento: 0, capacidadPct: 0, obligacionesPct,
      isOverloaded: true,
    }
  }

  // Ahorro — escala según salud financiera
  const remanentePct = (remanente / ingresoTotal) * 100
  let targetAhorroPct = remanentePct >= 40 ? 20 : remanentePct >= 25 ? 15 : remanentePct >= 15 ? 10 : 5
  const ahorro = Math.min((targetAhorroPct / 100) * ingresoTotal, remanente)
  const ahorroPct = (ahorro / ingresoTotal) * 100

  // Libre — tope 15%
  const afterAhorro = remanente - ahorro
  const maxLibre = (15 / 100) * ingresoTotal
  const libre = Math.min(afterAhorro, maxLibre)
  const librePct = (libre / ingresoTotal) * 100

  // Capacidad de endeudamiento — residual
  const capacidadEndeudamiento = Math.max(0, afterAhorro - libre)
  const capacidadPct = (capacidadEndeudamiento / ingresoTotal) * 100

  return {
    ingresoTotal, ingresoUser1: ingreso1, ingresoUser2: ingreso2,
    obligacionesTotal, obligacionesUser1: oblig1, obligacionesUser2: oblig2,
    ahorro, ahorroPct, libre, librePct,
    capacidadEndeudamiento, capacidadPct, obligacionesPct,
    isOverloaded: false,
  }
}

// ─── GET /home-budget ─────────────────────────────────────────────────────────
// Retorna el presupuesto unificado del hogar (pareja)

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    // Buscar la conexión de tipo PARTNER
    const partnerConn = await prisma.connection.findFirst({
      where: {
        status: 'ACCEPTED',
        role: 'PARTNER',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
    })

    if (!partnerConn) {
      res.status(404).json({ error: 'No tienes una conexión de pareja activa' })
      return
    }

    const partnerId = partnerConn.requesterId === userId ? partnerConn.addresseeId : partnerConn.requesterId
    const budget = await calculateHomeBudget(userId, partnerId)

    res.json({ budget, partnerId })
  } catch (error) {
    console.error('[HomeBudget]', error)
    res.status(500).json({ error: 'Error al calcular presupuesto del hogar' })
  }
})

export default router
