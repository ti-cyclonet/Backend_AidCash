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
  temporalidad: z.enum(['una_vez', 'definido', 'indefinido']),
  mesesRestantes: z.number().int().min(1).nullable().optional(),
  fechaRecepcion: z.string().optional(),
})

const updateSchema = z.object({
  nombre: z.string().min(1).optional(),
  monto: z.number().min(0).optional(),
  temporalidad: z.enum(['una_vez', 'definido', 'indefinido']).optional(),
  mesesRestantes: z.number().int().min(1).nullable().optional(),
}).strict()

// ─── GET /extra-incomes ───────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const extraIncomes = await prisma.extraIncome.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ extraIncomes })
  } catch (error) {
    console.error('[GetExtras]', error)
    res.status(500).json({ error: 'Error al obtener ingresos extra' })
  }
})

// ─── POST /extra-incomes ──────────────────────────────────────────────────────

router.post('/', validate(createSchema), checkLimit('nIngresosExtra'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, monto, temporalidad, mesesRestantes, fechaRecepcion } = req.body

    const income = await prisma.extraIncome.create({
      data: {
        userId, nombre, monto, temporalidad,
        mesesRestantes: mesesRestantes ?? null,
        fechaRecepcion: fechaRecepcion ? new Date(fechaRecepcion) : null,
      },
    })

    res.status(201).json({ extraIncome: income })
  } catch (error) {
    console.error('[CreateExtra]', error)
    res.status(500).json({ error: 'Error al crear ingreso extra' })
  }
})

// ─── PATCH /extra-incomes/:id ─────────────────────────────────────────────────

router.patch('/:id', validate(updateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.extraIncome.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Ingreso extra no encontrado' })
      return
    }

    const income = await prisma.extraIncome.update({
      where: { id },
      data: req.body,
    })

    res.json({ extraIncome: income })
  } catch (error) {
    console.error('[UpdateExtra]', error)
    res.status(500).json({ error: 'Error al actualizar ingreso extra' })
  }
})

// ─── DELETE /extra-incomes/:id ────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.extraIncome.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Ingreso extra no encontrado' })
      return
    }

    await prisma.extraIncome.delete({ where: { id } })
    res.json({ message: 'Ingreso extra eliminado' })
  } catch (error) {
    console.error('[DeleteExtra]', error)
    res.status(500).json({ error: 'Error al eliminar ingreso extra' })
  }
})

export default router
