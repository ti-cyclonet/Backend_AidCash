import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getMissionsForUser, claimMission, MissionKey } from '../lib/missions.js'

const router = Router()
router.use(authMiddleware)

// ─── GET /missions — Misiones de hoy + la semanal ─────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { daily, weekly } = await getMissionsForUser(userId)
    res.json({ daily, weekly })
  } catch (error) {
    console.error('[GetMissions]', error)
    res.status(500).json({ error: 'Error al obtener misiones' })
  }
})

// ─── POST /missions/:missionKey/claim — Reclamar recompensa ──────────────────

router.post('/:missionKey/claim', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const missionKey = req.params.missionKey as MissionKey

    const result = await claimMission(userId, missionKey)
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }

    res.json({ reward: result.reward })
  } catch (error) {
    console.error('[ClaimMission]', error)
    res.status(500).json({ error: 'Error al reclamar recompensa' })
  }
})

export default router
