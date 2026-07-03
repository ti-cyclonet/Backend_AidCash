import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

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

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
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

// ─── POST /fixed-expenses/:id/undo-pay ────────────────────────────────────────
// Revierte el pago de un gasto fijo. Devuelve el monto al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId, pagadoEstePeriodo: true } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo pagado no encontrado' })
      return
    }

    const montoDevolver = Number(existing.monto)

    // Transacción atómica: revertir gasto fijo + devolver cashBalance
    const [expense, user] = await prisma.$transaction([
      prisma.fixedExpense.update({
        where: { id },
        data: { pagadoEstePeriodo: false },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: montoDevolver },
        },
        select: {
          cashBalance: true,
          walletAhorro: true,
          walletObligaciones: true,
          walletLibre: true,
          walletEndeudamiento: true,
        },
      }),
    ])

    res.json({
      fixedExpense: expense,
      montoDevuelto: montoDevolver,
      wallet: {
        cashBalance: Number(user.cashBalance),
        ahorro: Number(user.walletAhorro),
        obligaciones: Number(user.walletObligaciones),
        libre: Number(user.walletLibre),
        endeudamiento: Number(user.walletEndeudamiento),
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
