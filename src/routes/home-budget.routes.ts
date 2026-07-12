import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

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

  // Obtener obligaciones pendientes de ambos
  const [debts1, debts2, fixed1, fixed2] = await Promise.all([
    prisma.debt.findMany({ where: { userId: userId1, estado: 'activa', pagadoEstePeriodo: false } }),
    prisma.debt.findMany({ where: { userId: userId2, estado: 'activa', pagadoEstePeriodo: false } }),
    prisma.fixedExpense.findMany({ where: { userId: userId1, pagadoEstePeriodo: false } }),
    prisma.fixedExpense.findMany({ where: { userId: userId2, pagadoEstePeriodo: false } }),
  ])

  const oblig1 = debts1.reduce((a, d) => a + Number(d.cuotaPeriodo), 0) + fixed1.reduce((a, f) => a + Number(f.monto), 0)
  const oblig2 = debts2.reduce((a, d) => a + Number(d.cuotaPeriodo), 0) + fixed2.reduce((a, f) => a + Number(f.monto), 0)
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
