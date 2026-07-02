import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const updateStreakSchema = z.object({
  streakActual: z.number().int().min(0),
  streakMejor: z.number().int().min(0).optional(),
})

const addBadgeSchema = z.object({
  badgeId: z.string().min(1),
})

// ─── GET /gamification/status ─────────────────────────────────────────────────

router.get('/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        streakActual: true,
        streakMejor: true,
        streakUltimoCheck: true,
      },
    })

    const badges = await prisma.userBadge.findMany({
      where: { userId },
      orderBy: { unlockedAt: 'desc' },
    })

    res.json({
      streak: {
        actual: user?.streakActual ?? 0,
        mejor: user?.streakMejor ?? 0,
        ultimoCheck: user?.streakUltimoCheck,
      },
      badges,
    })
  } catch (error) {
    console.error('[GetGamification]', error)
    res.status(500).json({ error: 'Error al obtener estado de gamificación' })
  }
})

// ─── PATCH /gamification/streak ───────────────────────────────────────────────

router.patch('/streak', validate(updateStreakSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { streakActual, streakMejor } = req.body

    const updateData: Record<string, unknown> = {
      streakActual,
      streakUltimoCheck: new Date(),
    }

    if (streakMejor !== undefined) {
      updateData.streakMejor = streakMejor
    } else if (streakActual > 0) {
      // Actualiza mejor si la actual lo supera
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { streakMejor: true },
      })
      if (user && streakActual > user.streakMejor) {
        updateData.streakMejor = streakActual
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { streakActual: true, streakMejor: true, streakUltimoCheck: true },
    })

    res.json({ streak: updated })
  } catch (error) {
    console.error('[UpdateStreak]', error)
    res.status(500).json({ error: 'Error al actualizar racha' })
  }
})

// ─── POST /gamification/badges ────────────────────────────────────────────────

router.post('/badges', validate(addBadgeSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { badgeId } = req.body

    // Upsert — no falla si ya existe
    const badge = await prisma.userBadge.upsert({
      where: { userId_badgeId: { userId, badgeId } },
      create: { userId, badgeId },
      update: {},
    })

    res.status(201).json({ badge })
  } catch (error) {
    console.error('[AddBadge]', error)
    res.status(500).json({ error: 'Error al desbloquear insignia' })
  }
})

// ─── GET /gamification/badges ─────────────────────────────────────────────────

router.get('/badges', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const badges = await prisma.userBadge.findMany({
      where: { userId },
      orderBy: { unlockedAt: 'desc' },
    })

    res.json({ badges })
  } catch (error) {
    console.error('[GetBadges]', error)
    res.status(500).json({ error: 'Error al obtener insignias' })
  }
})

export default router
