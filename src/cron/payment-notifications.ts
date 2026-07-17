/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Notificaciones Inteligentes de Pago
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Se ejecuta todos los días a las 8:00 AM.
 * Busca usuarios cuyo día de pago está próximo y les envía:
 *   - 2 días antes: "Ya casi te pagan. Antes de gastar, planifica con Kiri."
 *   - 1 día antes: "Mañana es día de pago. ¿Ya tienes tu plan listo?"
 *   - Día de pago: "¡Día de pago! Registra tu ingreso para distribuirlo."
 */

import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { emitToUser } from '../lib/socket.js'
import { sendPushToUser, pushKiriTip } from '../lib/push.js'

const SOCKET_EVENT = 'alert:payment_proximity'

/**
 * Calcula si un día de pago está a N días de distancia del día actual.
 * Maneja el cambio de mes (ej: hoy es 29, pago el 1 → faltan 2-3 días).
 */
function daysUntilPayday(today: number, payday: number, daysInMonth: number): number {
  if (payday >= today) return payday - today
  // El día de pago es en el "próximo ciclo" (siguiente mes)
  return (daysInMonth - today) + payday
}

export function initPaymentNotificationsCron() {
  // Ejecutar todos los días a las 8:00 AM (hora del servidor)
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Ejecutando notificaciones de pago...')

    try {
      const now = new Date()
      const today = now.getDate()
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

      // Buscar todos los usuarios que tienen días de pago configurados
      const users = await prisma.user.findMany({
        where: {
          diasPago: { isEmpty: false },
        },
        select: {
          id: true,
          nombre: true,
          diasPago: true,
          ingresoBase: true,
        },
      })

      let notified = 0

      for (const user of users) {
        for (const payday of user.diasPago) {
          const daysLeft = daysUntilPayday(today, payday, daysInMonth)

          let message: string | null = null
          let type: 'reminder_2d' | 'reminder_1d' | 'payday' | null = null

          if (daysLeft === 2) {
            message = `Ya casi te pagan (en 2 días). Antes de gastar, planifica con Kiri. 🌱`
            type = 'reminder_2d'
          } else if (daysLeft === 1) {
            message = `Mañana es día de pago. ¿Ya tienes tu plan listo? Kiri te ayuda a distribuir tu ingreso.`
            type = 'reminder_1d'
          } else if (daysLeft === 0) {
            message = `¡Día de pago! 🎉 Registra tu ingreso para distribuirlo inteligentemente con Kiri.`
            type = 'payday'
          }

          if (message && type) {
            // Emitir via Socket.io (si está conectado)
            emitToUser(user.id, SOCKET_EVENT, {
              message,
              type,
              payday,
              action: type === 'payday' ? 'register_income' : 'info',
            })

            // Enviar Push Notification (llega incluso con app cerrada)
            await pushKiriTip(user.id, message)

            notified++
            break // Solo una notificación por usuario por día
          }
        }
      }

      console.log(`[Cron] Notificaciones enviadas: ${notified} usuarios`)

      // ── Notificar ingresos extra próximos ──────────────────────────────────
      const extraIncomes = await prisma.extraIncome.findMany({
        where: {
          fechaRecepcion: { not: null },
          temporalidad: { not: 'una_vez' },
        },
        select: { id: true, userId: true, nombre: true, monto: true, fechaRecepcion: true },
      })

      for (const extra of extraIncomes) {
        if (!extra.fechaRecepcion) continue
        const extraDay = extra.fechaRecepcion.getDate()
        const daysLeft = daysUntilPayday(today, extraDay, daysInMonth)

        let extraMsg: string | null = null
        if (daysLeft === 2) {
          extraMsg = `📅 En 2 días recibes "${extra.nombre}" ($${Number(extra.monto).toLocaleString()}). ¡Planifica qué harás con ese ingreso!`
        } else if (daysLeft === 1) {
          extraMsg = `💰 Mañana recibes "${extra.nombre}" ($${Number(extra.monto).toLocaleString()}). ¿Ya sabes cómo distribuirlo?`
        } else if (daysLeft === 0) {
          extraMsg = `🎉 ¡Hoy recibes "${extra.nombre}" ($${Number(extra.monto).toLocaleString()})! Regístralo en Kiri.`
        }

        if (extraMsg) {
          emitToUser(extra.userId, SOCKET_EVENT, { message: extraMsg, type: 'extra_income', action: 'info' })
          await pushKiriTip(extra.userId, extraMsg)
        }
      }
    } catch (error) {
      console.error('[Cron] Error en notificaciones de pago:', error)
    }
  }, {
    timezone: 'America/Bogota',
  })

  // ── Cron diario 10:00 AM: tips motivacionales para usuarios inactivos ──────
  cron.schedule('0 10 * * *', async () => {
    try {
      // Buscar usuarios que no han iniciado sesión en 3+ días
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

      const inactiveUsers = await prisma.user.findMany({
        where: {
          updatedAt: { lt: threeDaysAgo },
          onboardingDone: true,
        },
        select: { id: true, nombre: true },
        take: 50,
      })

      const tips = [
        '🌱 ¡Te extrañamos! Revisa tu jardín financiero hoy.',
        '💡 Tip: Registrar tus gastos diarios te ayuda a ahorrar hasta un 20% más.',
        '🎯 ¿Ya revisaste si puedes abonar extra a alguna deuda esta semana?',
        '📊 Tu presupuesto te espera. Pequeñas acciones hoy, grandes resultados mañana.',
        '🐷 ¿Sabías que ahorrar aunque sea $1,000 al día suma $365,000 al año?',
      ]

      for (const user of inactiveUsers) {
        const tip = tips[Math.floor(Math.random() * tips.length)]
        await pushKiriTip(user.id, tip)
      }

      if (inactiveUsers.length > 0) {
        console.log(`[Cron] Tips motivacionales enviados a ${inactiveUsers.length} usuarios inactivos`)
      }
    } catch (error) {
      console.error('[Cron] Error en tips motivacionales:', error)
    }
  }, {
    timezone: 'America/Bogota',
  })

  console.log('[Cron] Payment notifications programado (8:00 AM diario)')
  console.log('[Cron] Motivational tips programado (10:00 AM diario)')
}
