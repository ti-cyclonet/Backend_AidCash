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

// ─── GET /impulse-expenses/top-consumos ───────────────────────────────────────
// Agrupa gastos por nombre, suma montos, ordena desc. Soporta filtro por categoría.
// IMPORTANTE: Esta ruta DEBE estar antes de /:id para que Express no la confunda.

router.get('/top-consumos', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const categoria = req.query.categoria as string | undefined
    const limit = parseInt(req.query.limit as string) || 10
    const periodo = req.query.periodo as string | undefined

    // Filtro base
    const where: Record<string, unknown> = { userId }
    if (categoria) where.categoria = categoria
    if (periodo) where.periodo = periodo
    else {
      // Default: periodo actual
      where.periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
    }

    // Agrupar por nombre y sumar montos
    const grouped = await prisma.impulseExpense.groupBy({
      by: ['nombre'],
      where,
      _sum: { monto: true },
      _count: { nombre: true },
      orderBy: { _sum: { monto: 'desc' } },
      take: limit,
    })

    // Total general del periodo (para calcular porcentajes)
    const totalResult = await prisma.impulseExpense.aggregate({
      where,
      _sum: { monto: true },
    })
    const totalGastado = Number(totalResult._sum.monto ?? 0)

    const items = grouped.map(g => {
      const totalItem = Number(g._sum.monto ?? 0)
      return {
        nombre: g.nombre,
        totalGastado: totalItem,
        cantidad: g._count.nombre,
        porcentaje: totalGastado > 0 ? Math.round((totalItem / totalGastado) * 1000) / 10 : 0,
      }
    })

    res.json({
      items,
      totalGastado,
      periodo: (periodo || where.periodo) as string,
    })
  } catch (error) {
    console.error('[TopConsumos]', error)
    res.status(500).json({ error: 'Error al obtener top consumos' })
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
