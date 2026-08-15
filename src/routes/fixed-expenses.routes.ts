import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { checkLimit } from '../middleware/limit-enforcement.js'

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
})

const updateSchema = z.object({
  nombre: z.string().min(1).optional(),
  monto: z.number().min(0).optional(),
  fechaCorte: z.string().optional(),
  categoria: z.enum(['vivienda', 'servicios', 'internet', 'transporte', 'educacion', 'salud', 'suscripciones', 'otro']).optional(),
  frecuencia: z.enum(['mensual', 'quincenal', 'semanal', 'anual']).optional(),
  metodoPago: z.string().nullable().optional(),
  renovacionAuto: z.boolean().optional(),
  pagadoEstePeriodo: z.boolean().optional(),
  montoPagadoEstePeriodo: z.number().min(0).nullable().optional(),
  tarjetaVinculadaId: z.string().nullable().optional(),
  pagoAutomatico: z.boolean().optional(),
}).strict()

// ─── GET /fixed-expenses ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const fixedExpenses = await prisma.fixedExpense.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ fixedExpenses })
  } catch (error) {
    console.error('[GetFixed]', error)
    res.status(500).json({ error: 'Error al obtener gastos fijos' })
  }
})

// ─── POST /fixed-expenses ─────────────────────────────────────────────────────

router.post('/', validate(createSchema), checkLimit('nGastosFijos'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, monto, fechaCorte, categoria, frecuencia, metodoPago, renovacionAuto } = req.body

    const expense = await prisma.fixedExpense.create({
      data: {
        userId, nombre, monto, fechaCorte,
        categoria: categoria ?? 'otro',
        frecuencia: frecuencia ?? 'mensual',
        metodoPago: metodoPago ?? null,
        renovacionAuto: renovacionAuto ?? false,
        pagadoEstePeriodo: false,
      },
    })

    res.status(201).json({ fixedExpense: expense })
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

    res.json({ fixedExpense: expense })
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

    const existing = await prisma.fixedExpense.findFirst({
      where: { id, userId },
      include: { tarjetaVinculada: true },
    })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    const montoTotal = Number(existing.monto)
    // Si es quincenal, el monto por periodo es la mitad del total
    const montoPorPeriodo = existing.frecuencia === "quincenal" ? Math.round(montoTotal / 2) : montoTotal
    const montoPago = req.body.monto ?? montoPorPeriodo
    const prevPaid = Number(existing.montoPagadoEstePeriodo ?? 0)
    const totalPaid = prevPaid + montoPago
    const isFullyPaid = totalPaid >= montoTotal

    if (existing.tarjetaVinculadaId && existing.tarjetaVinculada) {
      // ═══ PAGO CON TARJETA DE CRÉDITO ═══
      // Sumar al saldo de la tarjeta (la deuda de la tarjeta crece)
      // NO descontar del cashBalance (la tarjeta paga por ti)
      await prisma.$transaction([
        prisma.fixedExpense.update({
          where: { id },
          data: { pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
        }),
        prisma.debt.update({
          where: { id: existing.tarjetaVinculadaId },
          data: {
            saldoRestante: { increment: montoPago },
            saldoPrincipal: { increment: montoPago },
          },
        }),
      ])

      res.json({
        fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
        pagoConTarjeta: true,
        tarjetaNombre: existing.tarjetaVinculada.nombre,
        nuevoSaldoTarjeta: Number(existing.tarjetaVinculada.saldoRestante) + montoPago,
      })
    } else {
      // ═══ PAGO NORMAL ═══
      await prisma.fixedExpense.update({
        where: { id },
        data: { pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
      })

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

    // Buscar el gasto fijo que tenga algún pago (parcial o completo)
    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    // Si no tiene ningún pago registrado, no hay nada que deshacer
    const montoPagado = Number(existing.montoPagadoEstePeriodo ?? 0)
    if (montoPagado <= 0 && !existing.pagadoEstePeriodo) {
      res.status(400).json({ error: 'Este gasto no tiene pagos registrados' })
      return
    }

    const montoDevolver = montoPagado > 0 ? montoPagado : Number(existing.monto)

    if (existing.tarjetaVinculadaId) {
      // ═══ FUE PAGADO CON TARJETA → Restar del saldo de la tarjeta ═══
      const [expense] = await prisma.$transaction([
        prisma.fixedExpense.update({
          where: { id },
          data: { pagadoEstePeriodo: false, montoPagadoEstePeriodo: null },
        }),
        prisma.debt.update({
          where: { id: existing.tarjetaVinculadaId },
          data: {
            saldoRestante: { decrement: montoDevolver },
            saldoPrincipal: { decrement: montoDevolver },
          },
        }),
      ])

      // Obtener wallet actual (no cambió porque la TC pagó)
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { cashBalance: true, walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
      })

      res.json({
        fixedExpense: expense,
        montoDevuelto: montoDevolver,
        revertidoDeTarjeta: true,
        wallet: {
          cashBalance: Number(user?.cashBalance ?? 0),
          ahorro: Number(user?.walletAhorro ?? 0),
          obligaciones: Number(user?.walletObligaciones ?? 0),
          libre: Number(user?.walletLibre ?? 0),
          endeudamiento: Number(user?.walletEndeudamiento ?? 0),
        },
      })
    } else {
      // ═══ PAGO NORMAL → Devolver al cashBalance ═══
      const [expense, user] = await prisma.$transaction([
        prisma.fixedExpense.update({
          where: { id },
          data: { pagadoEstePeriodo: false, montoPagadoEstePeriodo: null },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            cashBalance: { increment: montoDevolver },
            walletObligaciones: { increment: montoDevolver },
          },
          select: { cashBalance: true, walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
        }),
      ])

      res.json({
        fixedExpense: expense,
        montoDevuelto: montoDevolver,
        revertidoDeTarjeta: false,
        wallet: {
          cashBalance: Number(user.cashBalance),
          ahorro: Number(user.walletAhorro),
          obligaciones: Number(user.walletObligaciones),
          libre: Number(user.walletLibre),
          endeudamiento: Number(user.walletEndeudamiento),
        },
      })
    }
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
