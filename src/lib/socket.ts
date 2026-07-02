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
import type { AuthPayload } from '../middleware/auth.js'

let io: SocketServer | null = null

// ─── Nombres de eventos (fuente de verdad compartida con el frontend) ──────────

export const SOCKET_EVENTS = {
  // Conexiones / invitaciones
  NEW_INVITE:        'notification:new_invite',
  INVITE_ACCEPTED:   'notification:invite_accepted',
  INVITE_REJECTED:   'notification:invite_rejected',

  // Bolsillo compartido
  SHARED_DEPOSIT:    'social:shared_deposit',

  // Préstamos
  LOAN_REQUESTED:    'loan:requested',
  LOAN_APPROVED:     'loan:approved',
  LOAN_REJECTED:     'loan:rejected',
  LOAN_PAYMENT:      'loan:payment_submitted',
  LOAN_PAYMENT_CONFIRMED: 'loan:payment_confirmed',
  LOAN_PAYMENT_REJECTED:  'loan:payment_rejected',
} as const

// ─── Inicialización ────────────────────────────────────────────────────────────

export function initSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: env.FRONTEND_URL,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
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

/** Emite un evento a la sala privada de un usuario específico */
export function emitToUser(userId: string, event: string, data: unknown): void {
  try {
    getIO().to(userId).emit(event, data)
  } catch {
    // Socket no inicializado en pruebas o SSR — silenciar
  }
}

/** Cierra limpiamente todas las conexiones Socket.io */
export function closeSocket(): void {
  if (io) {
    io.close()
    io = null
  }
}
