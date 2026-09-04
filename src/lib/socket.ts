/**
 * Kiri Finance — Socket.io manager
 *
 * Singleton que expone:
 *   - initSocket(httpServer)  → arranca Socket.io con JWT auth
 *   - getIO()                 → devuelve la instancia para emitir eventos
 *   - emitToUser(userId, event, data) → emite un evento a la sala privada del usuario
 */

import { Server as HttpServer } from 'http'
import { Server as SocketServer, Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { prisma } from '../config/database.js'
import type { AuthPayload } from '../middleware/auth.js'
import type { Prisma } from '@prisma/client'

let io: SocketServer | null = null

// ─── Nombres de eventos (fuente de verdad compartida con el frontend) ──────────

export const SOCKET_EVENTS = {
  // Conexiones / invitaciones
  NEW_INVITE:        'notification:new_invite',
  INVITE_ACCEPTED:   'notification:invite_accepted',
  INVITE_REJECTED:   'notification:invite_rejected',

  // Bolsillo compartido
  SHARED_DEPOSIT:    'social:shared_deposit',
  // Regar el jardín de un amigo
  GARDEN_WATERED:    'social:garden_watered',

  // Préstamos
  LOAN_REQUESTED:    'loan:requested',
  LOAN_APPROVED:     'loan:approved',
  LOAN_REJECTED:     'loan:rejected',
  LOAN_PAYMENT:      'loan:payment_submitted',
  LOAN_PAYMENT_CONFIRMED: 'loan:payment_confirmed',
  LOAN_PAYMENT_REJECTED:  'loan:payment_rejected',

  // Cambio de rol de una conexión (ej. Amigo → Pareja) — requiere que la
  // otra persona lo apruebe, igual que el interés de un préstamo.
  ROLE_CHANGE_REQUESTED: 'connection:role_change_requested',
  ROLE_CHANGE_ACCEPTED:  'connection:role_change_accepted',
  ROLE_CHANGE_REJECTED:  'connection:role_change_rejected',
} as const

// ─── Inicialización ────────────────────────────────────────────────────────────

export function initSocket(httpServer: HttpServer): SocketServer {
  const allowedOrigins = env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean)

  io = new SocketServer(httpServer, {
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) return callback(null, true)
        if (allowedOrigins.includes(origin)) return callback(null, true)
        callback(new Error('CORS_REJECTED'))
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['polling', 'websocket'],
    allowUpgrades: true,
    path: '/socket.io/',
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  // ── Middleware JWT: autentica cada conexión ────────────────────────────────
  io.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string) ||
      (socket.handshake.headers?.authorization as string)?.replace('Bearer ', '')

    if (!token) {
      return next(new Error('AUTH_REQUIRED'))
    }

    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload
      // Guardamos el userId en el socket para poder unirlo a su sala
      ;(socket as Socket & { userId: string }).userId = payload.userId
      next()
    } catch {
      next(new Error('INVALID_TOKEN'))
    }
  })

  // ── Eventos de conexión ────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const userId = (socket as Socket & { userId: string }).userId
    if (!userId) { socket.disconnect(); return }

    // Cada usuario se une a su sala privada (room = userId)
    socket.join(userId)
    console.log(`[Socket] User ${userId} connected (${socket.id})`)

    socket.on('disconnect', () => {
      console.log(`[Socket] User ${userId} disconnected (${socket.id})`)
    })
  })

  return io
}

// ─── Helpers públicos ─────────────────────────────────────────────────────────

export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized. Call initSocket() first.')
  return io
}

// Eventos que además de emitirse en vivo quedan guardados en la campana de
// notificaciones (tabla `Notification`) — mismo criterio que NOTIFICATION_EVENTS
// en Frontend_AidCash/src/lib/socket-context.tsx. Antes NINGÚN evento se
// guardaba en ningún lado: la campana vivía solo en memoria del navegador, así
// que un refresh (o simplemente cerrar la pestaña) la borraba por completo,
// aunque el evento real sí hubiera pasado.
const PERSISTED_EVENTS = new Set<string>([
  'notification:new_invite',
  'notification:invite_accepted',
  'notification:invite_rejected',
  'social:shared_deposit',
  'loan:requested',
  'loan:approved',
  'loan:rejected',
  'loan:payment_submitted',
  'loan:payment_confirmed',
  'loan:payment_rejected',
  'connection:role_change_requested',
  'connection:role_change_accepted',
  'connection:role_change_rejected',
  // Regar el jardín de un amigo — antes solo se emitía en vivo (socket) y
  // como push; si el usuario no tenía la app abierta en ese momento, no
  // quedaba ningún rastro al volver a entrar. Ahora también queda en la
  // campana de notificaciones, que es justo el empujón para que vuelva.
  'social:garden_watered',
])

/** Emite un evento a la sala privada de un usuario específico, y si es de los
 * que la campana de notificaciones debe recordar, lo guarda también. */
export function emitToUser(userId: string, event: string, data: unknown): void {
  try {
    getIO().to(userId).emit(event, data)
  } catch {
    // Socket no inicializado en pruebas o SSR — silenciar
  }

  if (PERSISTED_EVENTS.has(event)) {
    prisma.notification
      .create({ data: { userId, event, data: (data ?? {}) as Prisma.InputJsonValue } })
      .catch((error) => console.error('[Notification] Error al guardar:', error))
  }
}

/** Cierra limpiamente todas las conexiones Socket.io */
export function closeSocket(): void {
  if (io) {
    io.close()
    io = null
  }
}
