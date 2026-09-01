import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'
import { pushSocialInvite, pushGardenWatered } from '../lib/push.js'
import { checkLimit } from '../middleware/limit-enforcement.js'
import { getUserGardenHealth } from '../lib/garden-health.js'
import { todayPeriodo } from '../lib/missions.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const inviteSchema = z.object({
  method: z.enum(['username', 'correo']),
  value: z.string().min(1, 'Valor requerido'),
  role: z.enum(['FRIEND', 'FAMILY', 'PARTNER']).optional().default('FRIEND'),
})

// Selección de usuario reutilizada en todo este archivo — nunca incluye la
// contraseña ni datos sensibles, solo lo necesario para mostrar a un peer.
const PEER_SELECT = { id: true, nombre: true, correo: true, username: true, avatarUrl: true } as const

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
          requester: { select: PEER_SELECT },
          addressee: { select: PEER_SELECT },
        },
      }),
      prisma.connection.findMany({
        where: { addresseeId: userId, status: 'PENDING' },
        include: {
          requester: { select: PEER_SELECT },
        },
      }),
      prisma.connection.findMany({
        where: { requesterId: userId, status: 'PENDING' },
        include: {
          addressee: { select: PEER_SELECT },
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

router.post('/invite', validate(inviteSchema), checkLimit('nConexiones'), async (req: Request, res: Response): Promise<void> => {
  try {
    const requesterId = req.user!.userId
    const { method, value, role = 'FRIEND' } = req.body as {
      method: 'username' | 'correo'
      value: string
      role?: 'FRIEND' | 'FAMILY' | 'PARTNER'
    }
    const normalizedValue = value.trim().toLowerCase()

    const requester = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { correo: true, nombre: true, username: true },
    })

    const addressee = await prisma.user.findUnique({
      where: method === 'username' ? { username: normalizedValue } : { correo: normalizedValue },
      select: PEER_SELECT,
    })
    if (!addressee) {
      res.status(404).json({ error: 'No encontramos a nadie con ese dato exacto' })
      return
    }

    // No invitarse a sí mismo
    if (addressee.id === requesterId) {
      res.status(400).json({ error: 'No puedes invitarte a ti mismo' })
      return
    }

    // Restricción PARTNER: solo una conexión activa con este rol por usuario
    if (role === 'PARTNER') {
      const existingPartner = await prisma.connection.findFirst({
        where: {
          status: 'ACCEPTED',
          role: 'PARTNER',
          OR: [{ requesterId }, { addresseeId: requesterId }],
        },
      })
      if (existingPartner) {
        res.status(409).json({ error: 'Ya tienes una conexión de pareja activa. Solo puedes tener una.' })
        return
      }
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
      data: { requesterId, addresseeId: addressee.id, status: 'PENDING', role },
    })

    // Notificar en tiempo real al destinatario
    emitToUser(addressee.id, SOCKET_EVENTS.NEW_INVITE, {
      connectionId: connection.id,
      from: { id: requesterId, nombre: requester?.nombre, correo: requester?.correo },
      role,
    })

    // Push notification (llega incluso con la app cerrada)
    pushSocialInvite(addressee.id, requester?.nombre ?? 'Alguien')

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
        requester: { select: PEER_SELECT },
        addressee: { select: PEER_SELECT },
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

// ─── GET /connections/:id/shared — Vista unificada por conexión ───────────────
// Devuelve los bolsillos compartidos y préstamos entre el usuario y un peer

router.get('/:id/shared', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const connId = req.params.id as string

    // Verificar que la conexión existe y obtener el peer
    const conn = await prisma.connection.findFirst({
      where: { id: connId, status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
      include: {
        requester: { select: PEER_SELECT },
        addressee: { select: PEER_SELECT },
      },
    })
    if (!conn) {
      res.status(404).json({ error: 'Conexión no encontrada' })
      return
    }

    const peerId = conn.requesterId === userId ? conn.addresseeId : conn.requesterId
    const peer = conn.requesterId === userId ? conn.addressee : conn.requester

    // Bolsillos compartidos entre ambos
    const pockets = await prisma.sharedPocket.findMany({
      where: {
        AND: [
          { members: { some: { userId } } },
          { members: { some: { userId: peerId } } },
        ],
      },
      include: {
        members: { include: { user: { select: { id: true, nombre: true } } } },
        deposits: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    })

    // Cuánto ha aportado cada quien a cada bolsillo — el "Reto en pareja" necesita
    // el total real, no solo los últimos 5 depósitos.
    const pocketIds = pockets.map(p => p.id)
    const contributionRows = pocketIds.length > 0
      ? await prisma.sharedDeposit.groupBy({
          by: ['sharedPocketId', 'userId'],
          where: { sharedPocketId: { in: pocketIds } },
          _sum: { monto: true },
        })
      : []
    const contributionsByPocket = new Map<string, Record<string, number>>()
    for (const row of contributionRows) {
      const byUser = contributionsByPocket.get(row.sharedPocketId) ?? {}
      byUser[row.userId] = Number(row._sum.monto ?? 0)
      contributionsByPocket.set(row.sharedPocketId, byUser)
    }

    // Préstamos entre ambos
    const loans = await prisma.loan.findMany({
      where: {
        OR: [
          { lenderId: userId, borrowerId: peerId },
          { lenderId: peerId, borrowerId: userId },
        ],
      },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      connection: { id: conn.id, role: conn.role, createdAt: conn.createdAt },
      peer,
      pockets: pockets.map(p => ({
        id: p.id,
        nombre: p.nombre,
        balance: Number(p.balance),
        meta: Number(p.meta),
        deadline: p.deadline,
        members: p.members.map(m => ({ id: m.user.id, nombre: m.user.nombre, role: m.role })),
        recentDeposits: p.deposits.map(d => ({ ...d, monto: Number(d.monto) })),
        contributions: contributionsByPocket.get(p.id) ?? {},
      })),
      loans: loans.map(l => ({
        id: l.id,
        amount: Number(l.amount),
        remainingAmount: Number(l.remainingAmount),
        status: l.status,
        descripcion: l.descripcion,
        lenderId: l.lenderId,
        borrowerId: l.borrowerId,
        createdAt: l.createdAt,
        recentPayments: l.payments.map(p => ({ ...p, monto: Number(p.monto) })),
      })),
    })
  } catch (error) {
    console.error('[GetConnectionShared]', error)
    res.status(500).json({ error: 'Error al obtener datos compartidos' })
  }
})

// ─── PATCH /connections/:id/role ──────────────────────────────────────────────
// Cambiar el rol de una conexión existente

const updateRoleSchema = z.object({
  role: z.enum(['FRIEND', 'FAMILY', 'PARTNER']),
})

router.patch('/:id/role', validate(updateRoleSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { role } = req.body as { role: 'FRIEND' | 'FAMILY' | 'PARTNER' }

    const conn = await prisma.connection.findFirst({
      where: { id, status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    })
    if (!conn) {
      res.status(404).json({ error: 'Conexión no encontrada' })
      return
    }

    // Restricción PARTNER: solo una activa por usuario
    if (role === 'PARTNER') {
      const existingPartner = await prisma.connection.findFirst({
        where: {
          id: { not: id },
          status: 'ACCEPTED',
          role: 'PARTNER',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
      })
      if (existingPartner) {
        res.status(409).json({ error: 'Ya tienes una conexión de pareja activa.' })
        return
      }
    }

    const updated = await prisma.connection.update({
      where: { id },
      data: { role },
    })

    res.json({ connection: updated })
  } catch (error) {
    console.error('[UpdateConnectionRole]', error)
    res.status(500).json({ error: 'Error al actualizar rol' })
  }
})

// ─── GET /connections/friends-garden — Racha entre amigos + Jardines vecinos ──
// Solo conexiones role=FRIEND (nunca PARTNER/FAMILY — regla de diseño: estas
// secciones nunca muestran montos de dinero, solo racha y salud del jardín).

router.get('/friends-garden', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const periodo = todayPeriodo()

    const friendConnections = await prisma.connection.findMany({
      where: {
        status: 'ACCEPTED',
        role: 'FRIEND',
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: PEER_SELECT },
        addressee: { select: PEER_SELECT },
      },
    })

    const friends = await Promise.all(
      friendConnections.map(async (conn) => {
        const peer = conn.requesterId === userId ? conn.addressee : conn.requester
        const [peerUser, health, badgesCount, wateredByMe] = await Promise.all([
          prisma.user.findUnique({ where: { id: peer.id }, select: { streakActual: true, streakMejor: true } }),
          getUserGardenHealth(peer.id),
          prisma.userBadge.count({ where: { userId: peer.id } }),
          prisma.gardenWatering.findUnique({
            where: { waterId_targetUserId_periodo: { waterId: userId, targetUserId: peer.id, periodo } },
          }),
        ])
        return {
          connectionId: conn.id,
          peer: { id: peer.id, nombre: peer.nombre, username: peer.username, avatarUrl: peer.avatarUrl },
          streak: peerUser?.streakActual ?? 0,
          streakMejor: peerUser?.streakMejor ?? 0,
          badgesCount,
          health,
          wateredByMeToday: !!wateredByMe,
        }
      })
    )

    const [friendsWhoWateredYouToday, me, myHealth, myBadgesCount] = await Promise.all([
      prisma.gardenWatering.count({ where: { targetUserId: userId, periodo } }),
      prisma.user.findUnique({ where: { id: userId }, select: { streakActual: true, streakMejor: true } }),
      getUserGardenHealth(userId),
      prisma.userBadge.count({ where: { userId } }),
    ])

    res.json({
      friends,
      friendsWhoWateredYouToday,
      you: {
        streak: me?.streakActual ?? 0,
        streakMejor: me?.streakMejor ?? 0,
        badgesCount: myBadgesCount,
        health: myHealth,
      },
    })
  } catch (error) {
    console.error('[GetFriendsGarden]', error)
    res.status(500).json({ error: 'Error al obtener jardines de amigos' })
  }
})

// ─── POST /connections/:id/water — Regar el jardín de un amigo ───────────────
// Máximo 1 vez por conexión por día — validado acá, no solo deshabilitando el
// botón en el cliente.

router.post('/:id/water', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const conn = await prisma.connection.findFirst({
      where: { id, status: 'ACCEPTED', role: 'FRIEND', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    })
    if (!conn) {
      res.status(404).json({ error: 'Conexión de amistad no encontrada' })
      return
    }

    const targetUserId = conn.requesterId === userId ? conn.addresseeId : conn.requesterId
    const periodo = todayPeriodo()

    const already = await prisma.gardenWatering.findUnique({
      where: { waterId_targetUserId_periodo: { waterId: userId, targetUserId, periodo } },
    })
    if (already) {
      res.status(400).json({ error: 'Ya regaste este jardín hoy' })
      return
    }

    await prisma.gardenWatering.create({ data: { waterId: userId, targetUserId, periodo } })

    const waterer = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true } })
    emitToUser(targetUserId, 'social:garden_watered', { fromId: userId, fromName: waterer?.nombre ?? 'Un amigo' })
    pushGardenWatered(targetUserId, waterer?.nombre ?? 'Un amigo')

    res.status(201).json({ watered: true })
  } catch (error) {
    console.error('[WaterGarden]', error)
    res.status(500).json({ error: 'Error al regar el jardín' })
  }
})

export default router
