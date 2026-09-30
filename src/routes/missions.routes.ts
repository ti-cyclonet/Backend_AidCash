import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getMissionsForUser, getOnboardingMissionsForUser, getReferralMissionsForUser, claimMission, MissionKey } from '../lib/missions.js'
import { idiomaDePeticion, traducir } from '../lib/i18n.js'

const router = Router()
router.use(authMiddleware)

// ─── GET /missions — Misiones de hoy + la semanal + primeros pasos ────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const [{ daily, weekly }, onboarding, invitaciones] = await Promise.all([
      getMissionsForUser(userId),
      getOnboardingMissionsForUser(userId),
      getReferralMissionsForUser(userId),
    ])
    // Títulos y descripciones en el idioma de la app
    const idioma = idiomaDePeticion(req)
    const tx = <T extends { title: string; desc: string }>(m: T): T => ({ ...m, title: traducir(m.title, idioma), desc: traducir(m.desc, idioma) })
    const lista = <T extends { title: string; desc: string }>(l: T[] | undefined) => Array.isArray(l) ? l.map(tx) : l
    res.json({ daily: lista(daily), weekly: weekly ? tx(weekly) : weekly, onboarding: lista(onboarding), invitaciones: invitaciones ? { ...invitaciones, misiones: lista(invitaciones.misiones) } : invitaciones })
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
