import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { recordOnboardingAction } from '../lib/missions.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  monto: z.number().min(0),
  tipo: z.enum(['ahorro', 'sin_ahorro']),
  periodo: z.string().optional(),
})

// ─── GET /savings ─────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const limit = parseInt(req.query.limit as string) || 12

    const history = await prisma.savingsHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Total acumulado
    const totalResult = await prisma.savingsHistory.aggregate({
      where: { userId, tipo: 'ahorro' },
      _sum: { monto: true },
    })

    const totalAhorrado = Number(totalResult._sum.monto ?? 0)

    res.json({ history, totalAhorrado })
  } catch (error) {
    console.error('[GetSavings]', error)
    res.status(500).json({ error: 'Error al obtener historial de ahorro' })
  }
})

// ─── POST /savings ────────────────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo, periodo } = req.body

    // Si no se envía periodo, generar automáticamente
    const periodoFinal = periodo || new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    const entry = await prisma.savingsHistory.create({
      data: { userId, periodo: periodoFinal, monto, tipo },
    })

    // Actualizar total del usuario si es ahorro
    if (tipo === 'ahorro') {
      await prisma.user.update({
        where: { id: userId },
        data: {
          saldoAhorroTotal: { increment: monto },
        },
      })
      await recordOnboardingAction(userId, 'registrar_ahorro')
    }

    res.status(201).json({ entry })
  } catch (error) {
    console.error('[CreateSaving]', error)
    res.status(500).json({ error: 'Error al registrar ahorro' })
  }
})

// ─── DELETE /savings/:id ──────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const existing = await prisma.savingsHistory.findFirst({ where: { id, userId } })
    if (!existing) { res.status(404).json({ error: 'Registro no encontrado' }); return }
    await prisma.savingsHistory.delete({ where: { id } })
    res.json({ message: 'Registro eliminado' })
  } catch (error) {
    console.error('[DeleteSaving]', error)
    res.status(500).json({ error: 'Error al eliminar registro' })
  }
})

export default router
