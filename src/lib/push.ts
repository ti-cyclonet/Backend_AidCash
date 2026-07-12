/**
 * Kiri Finance — Web Push Notification Service
 *
 * Envía notificaciones push nativas a los dispositivos del usuario.
 * Funciona incluso cuando la app está cerrada o el celular bloqueado.
 */

import webpush from 'web-push'
import { prisma } from '../config/database.js'

// ─── Configuración VAPID ──────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? 'mailto:admin@kiri.app'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  console.log('[Push] VAPID configurado ✅')
} else {
  console.warn('[Push] VAPID_PUBLIC_KEY o VAPID_PRIVATE_KEY no configuradas. Push notifications deshabilitadas.')
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface PushPayload {
  title: string
  body: string
  icon?: string
  badge?: string
  tag?: string
  url?: string
  actions?: { action: string; title: string }[]
}

// ─── Enviar push a un usuario ─────────────────────────────────────────────────

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return

  try {
    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId },
    })

    if (subscriptions.length === 0) return

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon ?? '/icons/icon-192x192.png',
      badge: payload.badge ?? '/icons/icon-96x96.png',
      tag: payload.tag ?? 'kiri-notification',
      url: payload.url ?? '/dashboard',
      actions: payload.actions ?? [
        { action: 'open', title: 'Ver' },
        { action: 'dismiss', title: 'Cerrar' },
      ],
    })

    // Enviar a cada suscripción (el usuario puede tener múltiples dispositivos)
    const results = await Promise.allSettled(
      subscriptions.map(sub =>
        webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          pushPayload
        )
      )
    )

    // Eliminar suscripciones expiradas/inválidas (status 410 Gone)
    const expired = results
      .map((r, i) => ({ result: r, sub: subscriptions[i] }))
      .filter(({ result }) => result.status === 'rejected' && (result.reason as any)?.statusCode === 410)

    if (expired.length > 0) {
      await prisma.pushSubscription.deleteMany({
        where: { id: { in: expired.map(e => e.sub.id) } },
      })
    }
  } catch (error) {
    console.error('[Push] Error al enviar:', error)
  }
}

// ─── Helpers de notificación predefinidos ──────────────────────────────────────

export function pushSocialInvite(userId: string, fromName: string) {
  return sendPushToUser(userId, {
    title: '📬 Nueva solicitud social',
    body: `${fromName} quiere conectarse contigo en Kiri Finance.`,
    tag: 'social-invite',
    url: '/social',
  })
}

export function pushLoanPayment(userId: string, fromName: string, monto: number) {
  return sendPushToUser(userId, {
    title: '💸 Abono recibido',
    body: `${fromName} registró un abono de $${monto.toLocaleString('es-CO')} a tu préstamo.`,
    tag: 'loan-payment',
    url: '/social',
  })
}

export function pushPaymentReminder(userId: string, debtName: string, daysUntil: number) {
  return sendPushToUser(userId, {
    title: '⏰ Pago próximo a vencer',
    body: `Tu pago de "${debtName}" vence en ${daysUntil} día${daysUntil > 1 ? 's' : ''}. No olvides pagarlo.`,
    tag: 'payment-reminder',
    url: '/obligaciones',
  })
}

export function pushKiriTip(userId: string, message: string) {
  return sendPushToUser(userId, {
    title: '🌱 Consejo Kiri',
    body: message,
    tag: 'kiri-tip',
    url: '/gestion',
  })
}

export function pushSavingsDeposit(userId: string, pocketName: string, fromName: string) {
  return sendPushToUser(userId, {
    title: '💰 Depósito en bolsillo compartido',
    body: `${fromName} depositó en "${pocketName}".`,
    tag: 'savings-deposit',
    url: '/social',
  })
}
