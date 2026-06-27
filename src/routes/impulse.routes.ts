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
  categoria: z.enum(['cafe', 'comida', 'transporte', 'antojo', 'salida', 'otro']).default('otro'),
})

// ─── GET /impulse-expenses ────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const limit = parseInt(req.query.limit as string) || 50
    const periodo = req.query.periodo as string | undefined

    const where: Record<string, unknown> = { userId }
    if (periodo) where.periodo = periodo

    const expenses = await prisma.impulseExpense.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Total del periodo actual
    const currentPeriodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
    const totalResult = await prisma.impulseExpense.aggregate({
      where: { userId, periodo: currentPeriodo },
      _sum: { monto: true },
    })

    res.json({
      expenses,
      totalThisPeriod: Number(totalResult._sum.monto ?? 0),
      currentPeriodo,
    })
  } catch (error) {
    console.error('[GetImpulse]', error)
    res.status(500).json({ error: 'Error al obtener gastos hormiga' })
  }
})

// ─── POST /impulse-expenses ───────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, monto, categoria } = req.body

    const periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    const expense = await prisma.impulseExpense.create({
      data: { userId, nombre, monto, categoria, periodo },
    })

    res.status(201).json({ expense })
  } catch (error) {
    console.error('[CreateImpulse]', error)
    res.status(500).json({ error: 'Error al registrar gasto hormiga' })
  }
})

// ─── DELETE /impulse-expenses/:id ─────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.impulseExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto hormiga no encontrado' })
      return
    }

    await prisma.impulseExpense.delete({ where: { id } })
    res.json({ message: 'Gasto hormiga eliminado' })
  } catch (error) {
    console.error('[DeleteImpulse]', error)
    res.status(500).json({ error: 'Error al eliminar gasto hormiga' })
  }
})

export default router
