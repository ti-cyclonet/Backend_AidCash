import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const inviteSchema = z.object({
  correo: z.string().email('Correo inválido'),
})

const respondSchema = z.object({
  connectionId: z.string().min(1),
})

// ─── GET /connections  ────────────────────────────────────────────────────────
// Devuelve: conexiones aceptadas, pendientes enviadas, pendientes recibidas

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const [accepted, pendingReceived, pendingSent] = await Promise.all([
      prisma.connection.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        include: {
          requester: { select: { id: true, nombre: true, correo: true } },
          addressee: { select: { id: true, nombre: true, correo: true } },
        },
      }),
      prisma.connection.findMany({
        where: { addresseeId: userId, status: 'PENDING' },
        include: {
          requester: { select: { id: true, nombre: true, correo: true } },
        },
      }),
      prisma.connection.findMany({
        where: { requesterId: userId, status: 'PENDING' },
        include: {
          addressee: { select: { id: true, nombre: true, correo: true } },
        },
      }),
    ])

    res.json({ accepted, pendingReceived, pendingSent })
  } catch (error) {
    console.error('[GetConnections]', error)
    res.status(500).json({ error: 'Error al obtener conexiones' })
  }
})

// ─── POST /connections/invite ─────────────────────────────────────────────────

router.post('/invite', validate(inviteSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const requesterId = req.user!.userId
    const { correo } = req.body as { correo: string }

    // No invitarse a sí mismo
    const requester = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { correo: true, nombre: true },
    })
    if (requester?.correo === correo) {
      res.status(400).json({ error: 'No puedes invitarte a ti mismo' })
      return
    }

    const addressee = await prisma.user.findUnique({
      where: { correo },
      select: { id: true, nombre: true, correo: true },
    })
    if (!addressee) {
      res.status(404).json({ error: 'No existe ningún usuario con ese correo' })
      return
    }

    // Verificar que no exista ya una conexión entre ellos
    const existing = await prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId: addressee.id },
          { requesterId: addressee.id, addresseeId: requesterId },
        ],
      },
    })
    if (existing) {
      const msg =
        existing.status === 'ACCEPTED'  ? 'Ya estás conectado con este usuario' :
        existing.status === 'PENDING'   ? 'Ya existe una invitación pendiente'  :
        'Existe una solicitud previa rechazada'
      res.status(409).json({ error: msg })
      return
    }

    const connection = await prisma.connection.create({
      data: { requesterId, addresseeId: addressee.id, status: 'PENDING' },
    })

    // Notificar en tiempo real al destinatario
    emitToUser(addressee.id, SOCKET_EVENTS.NEW_INVITE, {
      connectionId: connection.id,
      from: { id: requesterId, nombre: requester?.nombre, correo: requester?.correo },
    })

    res.status(201).json({ connection, addressee })
  } catch (error) {
    console.error('[Invite]', error)
    res.status(500).json({ error: 'Error al enviar invitación' })
  }
})

// ─── POST /connections/accept ─────────────────────────────────────────────────

router.post('/accept', validate(respondSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { connectionId } = req.body as { connectionId: string }

    const conn = await prisma.connection.findFirst({
      where: { id: connectionId, addresseeId: userId, status: 'PENDING' },
      include: {
        requester: { select: { id: true, nombre: true, correo: true } },
        addressee: { select: { id: true, nombre: true, correo: true } },
      },
    })
    if (!conn) {
      res.status(404).json({ error: 'Invitación no encontrada o ya procesada' })
      return
    }

    const updated = await prisma.connection.update({
      where: { id: connectionId },
      data: { status: 'ACCEPTED' },
    })

    // Notificar al solicitante que fue aceptado
    emitToUser(conn.requesterId, SOCKET_EVENTS.INVITE_ACCEPTED, {
      connectionId: updated.id,
      by: { id: conn.addresseeId, nombre: conn.addressee.nombre, correo: conn.addressee.correo },
    })

    res.json({ connection: updated })
  } catch (error) {
    console.error('[AcceptConnection]', error)
    res.status(500).json({ error: 'Error al aceptar invitación' })
  }
})

// ─── POST /connections/reject ─────────────────────────────────────────────────

router.post('/reject', validate(respondSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { connectionId } = req.body as { connectionId: string }

    const conn = await prisma.connection.findFirst({
      where: { id: connectionId, addresseeId: userId, status: 'PENDING' },
    })
    if (!conn) {
      res.status(404).json({ error: 'Invitación no encontrada' })
      return
    }

    const updated = await prisma.connection.update({
      where: { id: connectionId },
      data: { status: 'REJECTED' },
    })

    emitToUser(conn.requesterId, SOCKET_EVENTS.INVITE_REJECTED, {
      connectionId: updated.id,
    })

    res.json({ connection: updated })
  } catch (error) {
    console.error('[RejectConnection]', error)
    res.status(500).json({ error: 'Error al rechazar invitación' })
  }
})

// ─── DELETE /connections/:id ──────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const conn = await prisma.connection.findFirst({
      where: {
        id,
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
    })
    if (!conn) {
      res.status(404).json({ error: 'Conexión no encontrada' })
      return
    }

    await prisma.connection.delete({ where: { id } })
    res.json({ message: 'Conexión eliminada' })
  } catch (error) {
    console.error('[DeleteConnection]', error)
    res.status(500).json({ error: 'Error al eliminar conexión' })
  }
})

export default router
