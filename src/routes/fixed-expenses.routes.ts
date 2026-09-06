import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { checkLimit } from '../middleware/limit-enforcement.js'
import { recordMissionAction, recordOnboardingAction } from '../lib/missions.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from '../lib/period.js'
import { planPocketDeduction } from '../lib/wallet.js'
import type { FixedExpensePayment, Prisma } from '@prisma/client'

// ─── Estado derivado por periodo (mismo patrón que debts.routes.ts) ────────────

function fixedStatus(payments: FixedExpensePayment[], periodo: string): { montoPagadoEstePeriodo: number } {
  const total = payments.filter(p => p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
  return { montoPagadoEstePeriodo: total }
}

// La frontera Q1/Q2 de un gasto fijo QUINCENAL usa su PROPIA `fechaCorte` (ej.
// "5,28" — las dos fechas reales de cobro de ESE gasto), no los días de pago
// del sueldo del usuario — ver misma nota en debts.routes.ts.
function fixedPeriodo(fe: { frecuencia: string; fechaCorte: string }, now: Date = new Date()): string {
  if (fe.frecuencia !== 'quincenal') return getPeriodo(fe.frecuencia, [], now)
  return getPeriodo('quincenal', parseDiasPago(fe.fechaCorte), now)
}

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  monto: z.number().min(0),
  fechaCorte: z.string().min(1),
  categoria: z.enum(['vivienda', 'servicios', 'internet', 'transporte', 'educacion', 'salud', 'suscripciones', 'otro']).optional(),
  frecuencia: z.enum(['mensual', 'quincenal', 'semanal', 'anual']).optional(),
  metodoPago: z.string().optional(),
  renovacionAuto: z.boolean().optional(),
  pagoAutomatico: z.boolean().optional(),
  // Si el usuario confirma que la cuota de ESTE periodo ya la pagó (por fuera
  // de Kiri, antes de registrar el gasto), sembramos un FixedExpensePayment
  // marcador — mismo patrón que en debts.routes.ts POST /debts.
  yaPagoEstePeriodo: z.boolean().optional(),
  // Antes faltaba acá — el formulario de creación ya deja elegir tarjeta,
  // pero el schema la descartaba silenciosamente y el gasto nacía sin vínculo.
  tarjetaVinculadaId: z.string().nullable().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
})

const updateSchema = z.object({
  nombre: z.string().min(1).optional(),
  monto: z.number().min(0).optional(),
  fechaCorte: z.string().optional(),
  categoria: z.enum(['vivienda', 'servicios', 'internet', 'transporte', 'educacion', 'salud', 'suscripciones', 'otro']).optional(),
  frecuencia: z.enum(['mensual', 'quincenal', 'semanal', 'anual']).optional(),
  metodoPago: z.string().nullable().optional(),
  renovacionAuto: z.boolean().optional(),
  tarjetaVinculadaId: z.string().nullable().optional(),
  pagoAutomatico: z.boolean().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
}).strict()

// ─── GET /fixed-expenses ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const fixedExpenses = await prisma.fixedExpense.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })

    // Traer los pagos recientes de todos los gastos fijos en una sola query.
    // 40 días cubre de sobra un mes, quincena, semana o incluso el arranque de un año.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const recentPayments = fixedExpenses.length > 0
      ? await prisma.fixedExpensePayment.findMany({
          where: { fixedExpenseId: { in: fixedExpenses.map(f => f.id) }, createdAt: { gte: fortyDaysAgo } },
        })
      : []
    const paymentsByExpense = new Map<string, FixedExpensePayment[]>()
    for (const p of recentPayments) {
      const arr = paymentsByExpense.get(p.fixedExpenseId) ?? []
      arr.push(p)
      paymentsByExpense.set(p.fixedExpenseId, arr)
    }

    res.json({
      fixedExpenses: fixedExpenses.map(f => {
        const periodo = fixedPeriodo(f)
        const montoPorPeriodo = getMontoPorPeriodo(Number(f.monto), f.frecuencia)
        const { montoPagadoEstePeriodo } = fixedStatus(paymentsByExpense.get(f.id) ?? [], periodo)
        return {
          ...f,
          pagadoEstePeriodo: montoPagadoEstePeriodo >= montoPorPeriodo,
          montoPagadoEstePeriodo: montoPagadoEstePeriodo > 0 ? montoPagadoEstePeriodo : null,
        }
      }),
    })
  } catch (error) {
    console.error('[GetFixed]', error)
    res.status(500).json({ error: 'Error al obtener gastos fijos' })
  }
})

// ─── POST /fixed-expenses ─────────────────────────────────────────────────────

router.post('/', validate(createSchema), checkLimit('nGastosFijos'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, monto, fechaCorte, categoria, frecuencia, metodoPago, renovacionAuto, pagoAutomatico, yaPagoEstePeriodo, tarjetaVinculadaId, budgetCategoryId } = req.body

    const expenseData = {
      userId, nombre, monto, fechaCorte,
      categoria: categoria ?? 'otro',
      frecuencia: frecuencia ?? 'mensual',
      metodoPago: metodoPago ?? null,
      renovacionAuto: renovacionAuto ?? false,
      pagoAutomatico: pagoAutomatico ?? false,
      tarjetaVinculadaId: tarjetaVinculadaId || null,
      budgetCategoryId: budgetCategoryId || null,
    }

    // Si ya pagó la cuota de este periodo, sembrar el pago marcador junto con
    // la creación — sin esto, el gasto nace "vencido" con un día que en
    // realidad ya está resuelto.
    const expense = yaPagoEstePeriodo
      ? await prisma.$transaction(async tx => {
          const created = await tx.fixedExpense.create({ data: expenseData })
          await tx.fixedExpensePayment.create({
            data: {
              fixedExpenseId: created.id,
              montoPagado: monto,
              periodo: fixedPeriodo(created),
            },
          })
          return created
        })
      : await prisma.fixedExpense.create({ data: expenseData })

    await recordOnboardingAction(userId, 'registrar_obligacion')

    res.status(201).json({
      fixedExpense: {
        ...expense,
        pagadoEstePeriodo: !!yaPagoEstePeriodo,
        montoPagadoEstePeriodo: yaPagoEstePeriodo ? Number(monto) : null,
      },
    })
  } catch (error) {
    console.error('[CreateFixed]', error)
    res.status(500).json({ error: 'Error al crear gasto fijo' })
  }
})

// ─── PATCH /fixed-expenses/:id ────────────────────────────────────────────────

router.patch('/:id', validate(updateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    const expense = await prisma.fixedExpense.update({
      where: { id },
      data: req.body,
    })

    if (req.body.categoria) {
      await recordMissionAction(userId, 'categorizar')
    }

    const periodo = fixedPeriodo(expense)
    const montoPorPeriodo = getMontoPorPeriodo(Number(expense.monto), expense.frecuencia)
    const payments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
    const { montoPagadoEstePeriodo } = fixedStatus(payments, periodo)

    res.json({
      fixedExpense: {
        ...expense,
        pagadoEstePeriodo: montoPagadoEstePeriodo >= montoPorPeriodo,
        montoPagadoEstePeriodo: montoPagadoEstePeriodo > 0 ? montoPagadoEstePeriodo : null,
      },
    })
  } catch (error) {
    console.error('[UpdateFixed]', error)
    res.status(500).json({ error: 'Error al actualizar gasto fijo' })
  }
})

// ─── PATCH /fixed-expenses/:id/pay — Pagar con lógica de tarjeta vinculada ────
// Si el gasto fijo tiene una tarjeta vinculada:
//   → Suma el monto al saldo_principal de esa tarjeta (como si compraras con TC)
//   → NO descuenta del cashBalance (la tarjeta "paga" por ti)
// Si NO tiene tarjeta:
//   → Proceso normal de pago (descuenta del cashBalance)

const payFixedSchema = z.object({
  monto: z.number().min(0.01).optional(),
}).strict()

router.patch('/:id/pay', validate(payFixedSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId }, include: { tarjetaVinculada: true } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    // El denominador de "¿ya pagué este periodo?" es lo que corresponde pagar
    // EN ESTE periodo (montoPorPeriodo), no el monto mensual completo — antes
    // comparaba contra el total mensual, así que un gasto quincenal nunca
    // llegaba a marcarse "pagado" con el abono quincenal correcto.
    const periodo = fixedPeriodo(existing)
    const montoPorPeriodo = getMontoPorPeriodo(Number(existing.monto), existing.frecuencia)
    const montoPago = req.body.monto ?? montoPorPeriodo
    const prevPayments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
    const prevPaid = prevPayments.reduce((s, p) => s + Number(p.montoPagado), 0)
    const totalPaid = prevPaid + montoPago
    const isFullyPaid = totalPaid >= montoPorPeriodo

    if (existing.tarjetaVinculadaId && existing.tarjetaVinculada) {
      // ═══ PAGO CON TARJETA DE CRÉDITO ═══
      // Sumar al saldo de la tarjeta (la deuda de la tarjeta crece)
      // NO descontar del cashBalance (la tarjeta paga por ti)
      await prisma.$transaction([
        // tarjetaId queda registrado en el propio pago (no solo en el gasto
        // fijo) para que undo-pay sepa revertirlo sin tener que re-consultar
        // el vínculo permanente — mismo campo que usa el pago puntual con TC.
        prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo, tarjetaId: existing.tarjetaVinculadaId } }),
        prisma.debt.update({
          where: { id: existing.tarjetaVinculadaId },
          data: {
            saldoRestante: { increment: montoPago },
            saldoPrincipal: { increment: montoPago },
          },
        }),
      ])

      await recordMissionAction(userId, 'pagar_obligacion')

      res.json({
        fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
        pagoConTarjeta: true,
        tarjetaNombre: existing.tarjetaVinculada.nombre,
        nuevoSaldoTarjeta: Number(existing.tarjetaVinculada.saldoRestante) + montoPago,
      })
    } else {
      // ═══ PAGO NORMAL ═══
      // El descuento de billetera va en la MISMA transacción que el pago —
      // antes era una segunda llamada HTTP aparte que si fallaba dejaba el
      // gasto "pagado" sin que el saldo disponible bajara.
      const walletDeductionData = planPocketDeduction('obligaciones', montoPago)

      await prisma.$transaction([
        prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo } }),
        prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
      ])

      await recordMissionAction(userId, 'pagar_obligacion')

      res.json({
        fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
        pagoConTarjeta: false,
      })
    }
  } catch (error) {
    console.error('[PayFixed]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── POST /fixed-expenses/:id/undo-pay ────────────────────────────────────────
// Revierte el pago de un gasto fijo. Devuelve el monto al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    // Solo se puede deshacer un pago dentro del periodo actual — un pago de un
    // periodo ya cerrado no se puede tocar (no hay columna mutable que "recuerde"
    // otra cosa).
    const periodo = fixedPeriodo(existing)
    const payments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
    if (payments.length === 0) {
      res.status(400).json({ error: 'Este gasto no tiene pagos registrados' })
      return
    }

    // Cada pago dice por sí mismo si salió en efectivo o de una tarjeta
    // (tarjetaVinculada permanente o un pay-with-card puntual) — ya no hace
    // falta adivinar por el vínculo del gasto fijo, que solo cubría un caso.
    const cashPayments = payments.filter(p => !p.tarjetaId)
    const cardPayments = payments.filter(p => p.tarjetaId)
    const montoDevolver = cashPayments.reduce((s, p) => s + Number(p.montoPagado), 0)

    const montoPorTarjeta = new Map<string, number>()
    const installmentIds = new Set<string>()
    for (const p of cardPayments) {
      montoPorTarjeta.set(p.tarjetaId!, (montoPorTarjeta.get(p.tarjetaId!) ?? 0) + Number(p.montoPagado))
      if (p.installmentId) installmentIds.add(p.installmentId)
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.fixedExpensePayment.deleteMany({ where: { fixedExpenseId: id, periodo } }),
    ]
    if (montoDevolver > 0) {
      ops.push(prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: montoDevolver },
          walletObligaciones: { increment: montoDevolver },
        },
      }))
    }
    for (const [tarjetaId, monto] of montoPorTarjeta) {
      ops.push(prisma.debt.update({
        where: { id: tarjetaId },
        data: {
          saldoRestante: { decrement: monto },
          saldoPrincipal: { decrement: monto },
        },
      }))
    }
    if (installmentIds.size > 0) {
      ops.push(prisma.debtCardInstallment.deleteMany({ where: { id: { in: [...installmentIds] } } }))
    }

    await prisma.$transaction(ops)

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true, walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
    })

    res.json({
      fixedExpense: { ...existing, pagadoEstePeriodo: false, montoPagadoEstePeriodo: null },
      montoDevuelto: montoDevolver,
      revertidoDeTarjeta: montoPorTarjeta.size > 0
        ? [...montoPorTarjeta.entries()].map(([tarjetaId, monto]) => ({ tarjetaId, monto }))
        : null,
      wallet: {
        cashBalance: Number(user?.cashBalance ?? 0),
        ahorro: Number(user?.walletAhorro ?? 0),
        obligaciones: Number(user?.walletObligaciones ?? 0),
        libre: Number(user?.walletLibre ?? 0),
        endeudamiento: Number(user?.walletEndeudamiento ?? 0),
      },
    })
  } catch (error) {
    console.error('[UndoPayFixed]', error)
    res.status(500).json({ error: 'Error al deshacer pago de gasto fijo' })
  }
})

// ─── DELETE /fixed-expenses/:id ───────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    await prisma.fixedExpense.delete({ where: { id } })
    res.json({ message: 'Gasto fijo eliminado' })
  } catch (error) {
    console.error('[DeleteFixed]', error)
    res.status(500).json({ error: 'Error al eliminar gasto fijo' })
  }
})

export default router
