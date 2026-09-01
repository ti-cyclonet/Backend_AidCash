import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { recordMissionAction } from '../lib/missions.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas de validación ────────────────────────────────────────────────────

const createCategorySchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido').max(50),
  icono: z.string().default('tag'),
  color: z.string().default('#6366F1'),
  tipo: z.enum(['gasto', 'ingreso', 'ahorro']).default('gasto'),
  montoLimite: z.number().min(0).optional().default(0),
  linkedFixedExpenseIds: z.array(z.string()).optional().default([]),
})

const updateCategorySchema = z.object({
  nombre: z.string().min(1).max(50).optional(),
  icono: z.string().optional(),
  color: z.string().optional(),
  tipo: z.enum(['gasto', 'ingreso', 'ahorro']).optional(),
  montoLimite: z.number().min(0).optional(),
  linkedFixedExpenseIds: z.array(z.string()).optional(),
})

/** Schema para bulk insert (migración desde localStorage) */
const bulkCreateSchema = z.object({
  categories: z.array(createCategorySchema).min(1).max(100),
})

// ─── GET /budget-categories — Listar categorías del usuario ───────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    // Filtrar opcionalmente por tipo
    const tipo = req.query.tipo as string | undefined
    const where: Record<string, unknown> = { userId }
    if (tipo) where.tipo = tipo

    const categories = await prisma.budgetCategory.findMany({
      where,
      orderBy: { nombre: 'asc' },
    })

    res.json({ categories: categories.map(c => ({ ...c, montoLimite: Number(c.montoLimite) })) })
  } catch (error) {
    console.error('[GetBudgetCategories]', error)
    res.status(500).json({ error: 'Error al obtener categorías de presupuesto' })
  }
})

// ─── POST /budget-categories — Crear una categoría ────────────────────────────

router.post('/', validate(createCategorySchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, icono, color, tipo, montoLimite, linkedFixedExpenseIds } = req.body

    const category = await prisma.budgetCategory.create({
      data: { userId, nombre, icono, color, tipo, montoLimite, linkedFixedExpenseIds },
    })

    await recordMissionAction(userId, 'categorizar')

    res.status(201).json({ category: { ...category, montoLimite: Number(category.montoLimite) } })
  } catch (error) {
    console.error('[CreateBudgetCategory]', error)
    res.status(500).json({ error: 'Error al crear categoría de presupuesto' })
  }
})

// ─── POST /budget-categories/bulk — Bulk insert (migración localStorage) ──────

router.post('/bulk', validate(bulkCreateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { categories } = req.body

    const created = await prisma.budgetCategory.createMany({
      data: categories.map((c: z.infer<typeof createCategorySchema>) => ({
        userId,
        nombre: c.nombre,
        icono: c.icono,
        color: c.color,
        tipo: c.tipo,
      })),
    })

    res.status(201).json({ count: created.count, message: 'Categorías migradas correctamente' })
  } catch (error) {
    console.error('[BulkCreateBudgetCategories]', error)
    res.status(500).json({ error: 'Error al migrar categorías de presupuesto' })
  }
})

// ─── PATCH /budget-categories/:id — Actualizar una categoría ──────────────────

router.patch('/:id', validate(updateCategorySchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.budgetCategory.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Categoría no encontrada' })
      return
    }

    const category = await prisma.budgetCategory.update({
      where: { id },
      data: req.body,
    })

    res.json({ category: { ...category, montoLimite: Number(category.montoLimite) } })
  } catch (error) {
    console.error('[UpdateBudgetCategory]', error)
    res.status(500).json({ error: 'Error al actualizar categoría' })
  }
})

// ─── DELETE /budget-categories/:id — Eliminar una categoría ───────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.budgetCategory.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Categoría no encontrada' })
      return
    }

    await prisma.budgetCategory.delete({ where: { id } })

    res.json({ message: 'Categoría eliminada correctamente' })
  } catch (error) {
    console.error('[DeleteBudgetCategory]', error)
    res.status(500).json({ error: 'Error al eliminar categoría' })
  }
})

export default router
