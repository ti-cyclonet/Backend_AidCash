import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'

/**
 * Notificaciones dentro de la app (campana) — antes solo existían en memoria
 * del navegador (SocketProvider): un refresh las borraba para siempre aunque
 * el evento real (invitación, préstamo, depósito compartido) sí hubiera
 * ocurrido. Los registros se crean desde emitToUser() en lib/socket.ts, en el
 * mismo momento en que se emite el evento en vivo — estas rutas solo leen y
 * marcan estado, nunca crean notificaciones por su cuenta.
 */

const router = Router()
router.use(authMiddleware)

// ─── GET /notifications — últimas 50, más recientes primero ──────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    res.json({ notifications })
  } catch (error) {
    console.error('[GetNotifications]', error)
    res.status(500).json({ error: 'Error al obtener notificaciones' })
  }
})

// ─── POST /notifications/read-all ─────────────────────────────────────────────

router.post('/read-all', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    })
    res.json({ message: 'Notificaciones marcadas como leídas' })
  } catch (error) {
    console.error('[ReadAllNotifications]', error)
    res.status(500).json({ error: 'Error al marcar notificaciones' })
  }
})

// ─── DELETE /notifications — limpiar todas ────────────────────────────────────

router.delete('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    await prisma.notification.deleteMany({ where: { userId } })
    res.json({ message: 'Notificaciones eliminadas' })
  } catch (error) {
    console.error('[ClearNotifications]', error)
    res.status(500).json({ error: 'Error al limpiar notificaciones' })
  }
})

export default router
