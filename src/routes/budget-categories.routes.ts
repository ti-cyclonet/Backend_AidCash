import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { checkLimit } from '../middleware/limit-enforcement.js'
import { recordMissionAction } from '../lib/missions.js'
import { resumenCategorias } from '../lib/category-summary.js'
import { sugerirCategoria } from '../lib/categorias.js'
import type { BudgetCategory } from '@prisma/client'

/**
 * Los gastos fijos de una categoría se guardan en la FK del propio gasto fijo
 * (FixedExpense.budgetCategoryId). El array legacy `linkedFixedExpenseIds` se
 * sigue aceptando/devolviendo para no romper el formulario, pero se traduce a
 * esa FK — antes convivían los dos mecanismos y un mismo gasto podía contar en
 * dos categorías a la vez.
 */
async function sincronizarFijos(userId: string, categoryId: string, fixedIds: string[]) {
  await prisma.$transaction([
    prisma.fixedExpense.updateMany({
      where: { userId, budgetCategoryId: categoryId, id: { notIn: fixedIds } },
      data: { budgetCategoryId: null },
    }),
    prisma.fixedExpense.updateMany({
      where: { userId, id: { in: fixedIds } },
      data: { budgetCategoryId: categoryId },
    }),
    prisma.budgetCategory.update({ where: { id: categoryId }, data: { linkedFixedExpenseIds: fixedIds } }),
  ])
}

async function conFijosVinculados(userId: string, categories: BudgetCategory[]) {
  const fijos = await prisma.fixedExpense.findMany({
    where: { userId, budgetCategoryId: { in: categories.map(c => c.id) } },
    select: { id: true, budgetCategoryId: true },
  })
  return categories.map(c => ({
    ...c,
    montoLimite: Number(c.montoLimite),
    linkedFixedExpenseIds: fijos.filter(f => f.budgetCategoryId === c.id).map(f => f.id),
  }))
}

const router = Router()
router.use(authMiddleware)

// ─── Schemas de validación ────────────────────────────────────────────────────

const createCategorySchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es requerido').max(50),
  icono: z.string().default('tag'),
  color: z.string().default('#6366F1'),
  tipo: z.enum(['gasto', 'ingreso', 'ahorro']).default('gasto'),
  montoLimite: z.number().min(0).optional().default(0),
  linkedFixedExpenseIds: z.array(z.string()).optional().default([]),
})

const updateCategorySchema = z.object({
  nombre: z.string().trim().min(1).max(50).optional(),
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

    res.json({ categories: await conFijosVinculados(userId, categories) })
  } catch (error) {
    console.error('[GetBudgetCategories]', error)
    res.status(500).json({ error: 'Error al obtener categorías de presupuesto' })
  }
})

// ─── GET /budget-categories/resumen — Gasto por categoría (fuente única) ──────
// ?alcance=periodo (default, periodo de ingreso actual) | mes (mes calendario)

router.get('/resumen', async (req: Request, res: Response): Promise<void> => {
  try {
    const alcance = req.query.alcance === 'mes' ? 'mes' : 'periodo'
    res.json(await resumenCategorias(req.user!.userId, alcance))
  } catch (error) {
    console.error('[ResumenCategorias]', error)
    res.status(500).json({ error: 'Error al calcular el resumen de categorías' })
  }
})

// ─── GET /budget-categories/sugerir?nombre= — Categoría sugerida para un gasto ─

router.get('/sugerir', async (req: Request, res: Response): Promise<void> => {
  try {
    const nombre = String(req.query.nombre ?? '').slice(0, 120)
    res.json({ sugerencia: nombre ? await sugerirCategoria(req.user!.userId, nombre) : null })
  } catch (error) {
    console.error('[SugerirCategoria]', error)
    res.status(500).json({ error: 'Error al sugerir categoría' })
  }
})

// ─── POST /budget-categories — Crear una categoría ────────────────────────────

router.post('/', validate(createCategorySchema), checkLimit('nCategorias'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, icono, color, tipo, montoLimite, linkedFixedExpenseIds } = req.body

    const category = await prisma.budgetCategory.create({
      data: { userId, nombre, icono, color, tipo, montoLimite },
    })
    if (linkedFixedExpenseIds.length > 0) await sincronizarFijos(userId, category.id, linkedFixedExpenseIds)

    await recordMissionAction(userId, 'categorizar')

    const [out] = await conFijosVinculados(userId, [category])
    res.status(201).json({ category: out })
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

    const { linkedFixedExpenseIds, ...fields } = req.body as z.infer<typeof updateCategorySchema>
    const category = await prisma.budgetCategory.update({ where: { id }, data: fields })
    if (linkedFixedExpenseIds) await sincronizarFijos(userId, id, linkedFixedExpenseIds)

    const [out] = await conFijosVinculados(userId, [category])
    res.json({ category: out })
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
