import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas de validación ────────────────────────────────────────────────────

const createPocketSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido').max(50),
  meta: z.number().min(0).default(0),
  montoActual: z.number().min(0).default(0),
  color: z.string().default('#10B981'),
  icono: z.string().default('piggy-bank'),
})

const updatePocketSchema = z.object({
  nombre: z.string().min(1).max(50).optional(),
  meta: z.number().min(0).optional(),
  montoActual: z.number().min(0).optional(),
  color: z.string().optional(),
  icono: z.string().optional(),
})

/** Schema para bulk insert (migración desde localStorage) */
const bulkCreateSchema = z.object({
  pockets: z.array(createPocketSchema).min(1).max(50),
})

// ─── GET /savings-pockets — Listar bolsillos del usuario ──────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const pockets = await prisma.savingsPocket.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })

    res.json({ pockets })
  } catch (error) {
    console.error('[GetSavingsPockets]', error)
    res.status(500).json({ error: 'Error al obtener bolsillos de ahorro' })
  }
})

// ─── POST /savings-pockets — Crear un bolsillo ───────────────────────────────

router.post('/', validate(createPocketSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, meta, montoActual, color, icono } = req.body

    const pocket = await prisma.savingsPocket.create({
      data: { userId, nombre, meta, montoActual, color, icono },
    })

    res.status(201).json({ pocket })
  } catch (error) {
    console.error('[CreateSavingsPocket]', error)
    res.status(500).json({ error: 'Error al crear bolsillo de ahorro' })
  }
})

// ─── POST /savings-pockets/bulk — Bulk insert (migración localStorage) ────────

router.post('/bulk', validate(bulkCreateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { pockets } = req.body

    const created = await prisma.savingsPocket.createMany({
      data: pockets.map((p: z.infer<typeof createPocketSchema>) => ({
        userId,
        nombre: p.nombre,
        meta: p.meta,
        montoActual: p.montoActual,
        color: p.color,
        icono: p.icono,
      })),
    })

    res.status(201).json({ count: created.count, message: 'Bolsillos migrados correctamente' })
  } catch (error) {
    console.error('[BulkCreateSavingsPockets]', error)
    res.status(500).json({ error: 'Error al migrar bolsillos de ahorro' })
  }
})

// ─── PATCH /savings-pockets/:id — Actualizar un bolsillo ──────────────────────

router.patch('/:id', validate(updatePocketSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    // Verificar que el bolsillo pertenece al usuario
    const existing = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    const pocket = await prisma.savingsPocket.update({
      where: { id },
      data: req.body,
    })

    res.json({ pocket })
  } catch (error) {
    console.error('[UpdateSavingsPocket]', error)
    res.status(500).json({ error: 'Error al actualizar bolsillo de ahorro' })
  }
})

// ─── DELETE /savings-pockets/:id — Eliminar un bolsillo ───────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    await prisma.savingsPocket.delete({ where: { id } })

    res.json({ message: 'Bolsillo eliminado correctamente' })
  } catch (error) {
    console.error('[DeleteSavingsPocket]', error)
    res.status(500).json({ error: 'Error al eliminar bolsillo de ahorro' })
  }
})

export default router
