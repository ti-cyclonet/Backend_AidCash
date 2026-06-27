import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createDebtSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  montoTotal: z.number().min(0),
  cuotaPeriodo: z.number().min(0),
  fechaVencimiento: z.string().min(1),
})

const updateDebtSchema = z.object({
  nombre: z.string().min(1).optional(),
  montoTotal: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0).optional(),
  fechaVencimiento: z.string().optional(),
  pagadoEstePeriodo: z.boolean().optional(),
  estado: z.enum(['activa', 'saldada']).optional(),
}).strict()

// ─── GET /debts ───────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const estado = (req.query.estado as string) || 'activa'

    const debts = await prisma.debt.findMany({
      where: { userId, estado },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ debts })
  } catch (error) {
    console.error('[GetDebts]', error)
    res.status(500).json({ error: 'Error al obtener deudas' })
  }
})

// ─── POST /debts ──────────────────────────────────────────────────────────────

router.post('/', validate(createDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, montoTotal, cuotaPeriodo, fechaVencimiento } = req.body

    const debt = await prisma.debt.create({
      data: {
        userId,
        nombre,
        montoTotal,
        cuotaPeriodo,
        fechaVencimiento,
        pagadoEstePeriodo: false,
        estado: 'activa',
      },
    })

    res.status(201).json({ debt })
  } catch (error) {
    console.error('[CreateDebt]', error)
    res.status(500).json({ error: 'Error al crear deuda' })
  }
})

// ─── PATCH /debts/:id ─────────────────────────────────────────────────────────

router.patch('/:id', validate(updateDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    // Verificar pertenencia
    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    const debt = await prisma.debt.update({
      where: { id },
      data: req.body,
    })

    res.json({ debt })
  } catch (error) {
    console.error('[UpdateDebt]', error)
    res.status(500).json({ error: 'Error al actualizar deuda' })
  }
})

// ─── POST /debts/:id/pay ──────────────────────────────────────────────────────

router.post('/:id/pay', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { montoTotal, pagadoEstePeriodo } = req.body

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    const debt = await prisma.debt.update({
      where: { id },
      data: {
        montoTotal: montoTotal ?? existing.montoTotal,
        pagadoEstePeriodo: pagadoEstePeriodo ?? true,
      },
    })

    res.json({ debt })
  } catch (error) {
    console.error('[PayDebt]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── DELETE /debts/:id ────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    await prisma.debt.delete({ where: { id } })
    res.json({ message: 'Deuda eliminada' })
  } catch (error) {
    console.error('[DeleteDebt]', error)
    res.status(500).json({ error: 'Error al eliminar deuda' })
  }
})

export default router
