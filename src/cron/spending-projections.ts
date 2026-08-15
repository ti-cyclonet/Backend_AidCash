/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Proyecciones de Gasto con IA Proactiva
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Se ejecuta todos los días a las 9:00 AM (después de las notificaciones de pago).
 *
 * Para cada usuario:
 *   1. Calcula la velocidad de gasto diario del walletLibre
 *      basada en los gastos hormiga de los últimos 7 días.
 *   2. Proyecta cuántos días de fondos le quedan a ese ritmo.
 *   3. Si la proyección indica que se quedará sin dinero libre antes
 *      de su próximo día de pago → envía alerta push preventiva.
 *   4. Detecta patrones de gasto acelerado (velocidad creciente)
 *      y alerta antes de que sea demasiado tarde.
 *
 * Niveles de alerta:
 *   🟡 PRECAUCIÓN: Fondos duran ≤ 5 días a ritmo actual
 *   🔴 URGENTE: Fondos duran ≤ 2 días o se acabarán antes del próximo pago
 *   📈 ACELERACIÓN: Velocidad de gasto aumentó >30% vs semana anterior
 */

import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { sendPushToUser } from '../lib/push.js'
import { emitToUser } from '../lib/socket.js'

const SOCKET_EVENT = 'alert:spending_projection'

// ─── Tipos internos ──────────────────────────────────────────────────────────

interface UserProjection {
  userId: string
  nombre: string
  walletLibre: number
  gastoPromediodiario: number
  diasRestantes: number
  diasHastaPago: number
  velocidadSemanaActual: number
  velocidadSemanaAnterior: number
  alertLevel: 'none' | 'caution' | 'urgent' | 'acceleration'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Calcula cuántos días faltan hasta el próximo día de pago del usuario.
 */
function daysUntilNextPayday(diasPago: number[], today: number, daysInMonth: number): number {
  if (diasPago.length === 0) return 30 // Default: asumir ciclo mensual

  // Encontrar el próximo día de pago más cercano
  let minDays = Infinity
  for (const payday of diasPago) {
    const days = payday >= today
      ? payday - today
      : (daysInMonth - today) + payday
    if (days < minDays) minDays = days
  }

  return minDays === 0 ? 30 : minDays // Si hoy es día de pago, próximo ciclo = ~30 días
}

/**
 * Obtiene el gasto total de un usuario en un rango de fechas.
 */
async function getSpendingInRange(userId: string, from: Date, to: Date): Promise<number> {
  const result = await prisma.impulseExpense.aggregate({
    where: {
      userId,
      createdAt: { gte: from, lte: to },
    },
    _sum: { monto: true },
  })
  return Number(result._sum.monto ?? 0)
}

/**
 * Genera el mensaje de alerta según el nivel.
 */
function buildAlertMessage(projection: UserProjection): string {
  const { diasRestantes, gastoPromediodiario, walletLibre, diasHastaPago } = projection
  const formatMoney = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`

  if (projection.alertLevel === 'urgent') {
    if (diasRestantes <= 0) {
      return `🚨 Tu wallet libre está en $0. Tu próximo pago llega en ${diasHastaPago} días. Evita gastos innecesarios.`
    }
    return `🔴 Alerta: A tu ritmo actual (${formatMoney(gastoPromediodiario)}/día), tu wallet libre (${formatMoney(walletLibre)}) se agotará en ${Math.ceil(diasRestantes)} días, pero tu próximo pago llega en ${diasHastaPago} días. Reduce tus gastos hormiga hoy.`
  }

  if (projection.alertLevel === 'caution') {
    return `🟡 Atención: Tu wallet libre (${formatMoney(walletLibre)}) alcanza para ~${Math.ceil(diasRestantes)} días más a tu ritmo actual. Considera reducir gastos hormiga esta semana.`
  }

  if (projection.alertLevel === 'acceleration') {
    const increase = Math.round(
      ((projection.velocidadSemanaActual - projection.velocidadSemanaAnterior) / projection.velocidadSemanaAnterior) * 100
    )
    return `📈 Tu velocidad de gasto aumentó un ${increase}% esta semana vs la anterior. Si mantienes este ritmo, podrías quedarte corto antes de fin de mes. ¿Necesitas ajustar tu presupuesto?`
  }

  return ''
}

// ─── Job principal ────────────────────────────────────────────────────────────

async function runSpendingProjections(): Promise<void> {
  console.log('[SpendingProjections] Analizando velocidad de gasto...')

  const now = new Date()
  const today = now.getDate()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

  // Rangos de tiempo para el análisis
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)

  // Buscar usuarios con wallet libre > 0 y onboarding completado
  const users = await prisma.user.findMany({
    where: {
      onboardingDone: true,
      walletLibre: { gt: 0 },
    },
    select: {
      id: true,
      nombre: true,
      walletLibre: true,
      diasPago: true,
      frecuenciaIngreso: true,
    },
  })

  if (users.length === 0) {
    console.log('[SpendingProjections] No hay usuarios elegibles')
    return
  }

  let alertsSent = 0

  for (const user of users) {
    try {
      const walletLibre = Number(user.walletLibre)

      // Calcular gasto de la semana actual (últimos 7 días)
      const spendingThisWeek = await getSpendingInRange(user.id, sevenDaysAgo, now)
      // Calcular gasto de la semana anterior (7-14 días atrás)
      const spendingLastWeek = await getSpendingInRange(user.id, fourteenDaysAgo, sevenDaysAgo)

      // Promedio diario (últimos 7 días)
      const dailyAvg = spendingThisWeek / 7
      const dailyAvgLastWeek = spendingLastWeek / 7

      // Si no hay gastos, no alertar
      if (dailyAvg === 0) continue

      // Días que durarán los fondos libres a este ritmo
      const diasRestantes = walletLibre / dailyAvg

      // Días hasta el próximo pago
      const diasHastaPago = daysUntilNextPayday(user.diasPago, today, daysInMonth)

      // Determinar nivel de alerta
      let alertLevel: UserProjection['alertLevel'] = 'none'

      // 🔴 URGENTE: se queda sin fondos antes del próximo pago
      if (diasRestantes <= 2 || diasRestantes < diasHastaPago * 0.5) {
        alertLevel = 'urgent'
      }
      // 🟡 PRECAUCIÓN: fondos duran ≤ 5 días
      else if (diasRestantes <= 5) {
        alertLevel = 'caution'
      }
      // 📈 ACELERACIÓN: gasto aumentó >30% vs semana anterior
      else if (dailyAvgLastWeek > 0 && dailyAvg > dailyAvgLastWeek * 1.3) {
        alertLevel = 'acceleration'
      }

      if (alertLevel === 'none') continue

      const projection: UserProjection = {
        userId: user.id,
        nombre: user.nombre,
        walletLibre,
        gastoPromediodiario: dailyAvg,
        diasRestantes,
        diasHastaPago,
        velocidadSemanaActual: spendingThisWeek,
        velocidadSemanaAnterior: spendingLastWeek,
        alertLevel,
      }

      const message = buildAlertMessage(projection)
      if (!message) continue

      // Enviar via Socket.io (tiempo real si está conectado)
      emitToUser(user.id, SOCKET_EVENT, {
        message,
        alertLevel,
        projection: {
          walletLibre,
          gastoPromediodiario: Math.round(dailyAvg),
          diasRestantes: Math.ceil(diasRestantes),
          diasHastaPago,
        },
        action: 'review_spending',
      })

      // Enviar Push Notification
      await sendPushToUser(user.id, {
        title: alertLevel === 'urgent' ? '🔴 Alerta de fondos' : alertLevel === 'caution' ? '🟡 Precaución' : '📈 Patrón detectado',
        body: message,
        tag: `spending-projection-${alertLevel}`,
        url: '/gestion',
        actions: [
          { action: 'open', title: 'Ver gastos' },
          { action: 'dismiss', title: 'Cerrar' },
        ],
      })

      alertsSent++
    } catch (error) {
      console.error(`[SpendingProjections] Error procesando usuario ${user.id}:`, error)
    }
  }

  console.log(`[SpendingProjections] Completado: ${alertsSent} alertas enviadas de ${users.length} usuarios analizados`)
}

// ─── Exportar inicializador ───────────────────────────────────────────────────

export function initSpendingProjectionsCron() {
  // Ejecutar a las 9:00 AM todos los días (después del cron de pagos de 8:00 AM)
  cron.schedule('0 9 * * *', () => {
    runSpendingProjections().catch(err => {
      console.error('[SpendingProjections] Error fatal en cron:', err)
    })
  }, {
    timezone: 'America/Bogota',
  })

  console.log('  🧠 Cron Spending Projections: activo (9:00 AM diario)')
}
