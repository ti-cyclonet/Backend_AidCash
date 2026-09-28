import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { obtenerEnlace, infoPublicaEnlace, aceptarEnlaceExistente, contarReferidos } from '../lib/invitaciones.js'

const router = Router()

const rolSchema = z.enum(['FRIEND', 'FAMILY', 'PARTNER'])

// ─── GET /invite-links/publico/:code — sin sesión ─────────────────────────────
// Lo usa la pantalla /invitacion/[code] y el registro para mostrar quién
// invita ("Carlos te invitó a Kiri como amigo"). Solo datos públicos.

router.get('/publico/:code', async (req: Request, res: Response): Promise<void> => {
  try {
    const info = await infoPublicaEnlace(String(req.params.code))
    if (!info) { res.status(404).json({ error: 'Este enlace de invitación no existe' }); return }
    res.json(info)
  } catch (error) {
    console.error('[InviteLinkPublic]', error)
    res.status(500).json({ error: 'Error al leer la invitación' })
  }
})

router.use(authMiddleware)

// ─── GET /invite-links?role=FRIEND — mi enlace para ese tipo de relación ──────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const role = rolSchema.catch('FRIEND').parse(req.query.role)
    const userId = req.user!.userId
    const [link, referidos] = await Promise.all([obtenerEnlace(userId, role), contarReferidos(userId)])
    res.json({ code: link.code, role: link.role, usos: link.usos, referidos })
  } catch (error) {
    console.error('[InviteLinkGet]', error)
    res.status(500).json({ error: 'Error al generar tu enlace' })
  }
})

// ─── POST /invite-links/:code/aceptar — ya tenía cuenta, conectarse directo ───

router.post('/:code/aceptar', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await aceptarEnlaceExistente(String(req.params.code), req.user!.userId)
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return }
    res.json({ role: r.role, inviter: r.inviter, yaConectados: r.yaConectados })
  } catch (error) {
    console.error('[InviteLinkAccept]', error)
    res.status(500).json({ error: 'Error al aceptar la invitación' })
  }
})

export default router
