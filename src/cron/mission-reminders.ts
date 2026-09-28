/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Recordatorios de misiones diarias
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Antes las misiones solo avisaban cuando ya estaban completas (pushMissionReady):
 * nada invitaba a hacerlas. Ahora, a usuarios activos en los últimos 30 días:
 *   - 10:30 AM → "Tus misiones de hoy te esperan" (si aún tiene alguna pendiente)
 *   -  6:30 PM → solo si vale la pena: cofres completos sin reclamar, o una
 *                racha que se pierde si hoy no hace nada.
 * Cada aviso queda en la campana (evento persistido) y llega como push.
 */
import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'
import { pushMissionReminder } from '../lib/push.js'
import { MISSION_CATALOG, todayPeriodo } from '../lib/missions.js'

type Momento = 'manana' | 'tarde'
const DIA = 86_400_000

interface EstadoDia { pendientes: number; porReclamar: number }

async function estadoDelDia(userIds: string[], periodo: string): Promise<Map<string, EstadoDia>> {
  const filas = await prisma.missionProgress.findMany({
    where: { userId: { in: userIds }, periodo, missionKey: { in: MISSION_CATALOG.map((m) => m.key) } },
    select: { userId: true, progress: true, target: true, claimedAt: true },
  })
  const mapa = new Map<string, EstadoDia>()
  for (const id of userIds) mapa.set(id, { pendientes: MISSION_CATALOG.length, porReclamar: 0 })
  for (const f of filas) {
    const e = mapa.get(f.userId)!
    if (f.progress >= f.target) {
      e.pendientes--
      if (!f.claimedAt) e.porReclamar++
    }
  }
  return mapa
}

export async function runMissionReminders(momento: Momento, now: Date = new Date()): Promise<number> {
  const desde = new Date(now.getTime() - 30 * DIA)
  const usuarios = await prisma.user.findMany({
    where: { isActive: true, onboardingDone: true, OR: [{ streakUltimoCheck: { gte: desde } }, { createdAt: { gte: desde } }] },
    select: { id: true, nombre: true, streakActual: true, streakUltimoCheck: true },
  })
  if (usuarios.length === 0) return 0

  const periodo = todayPeriodo(now)
  const estado = await estadoDelDia(usuarios.map((u) => u.id), periodo)
  const hoyUTC = now.toISOString().slice(0, 10)
  let enviados = 0

  for (const u of usuarios) {
    const e = estado.get(u.id)!
    const nombre = u.nombre.split(' ')[0]
    let aviso: { title: string; body: string } | null = null

    if (momento === 'manana') {
      if (e.pendientes > 0) {
        aviso = {
          title: '🎯 Tus misiones de hoy te esperan',
          body: `${nombre}, tienes ${e.pendientes} misión${e.pendientes === 1 ? '' : 'es'} y un cofre sorpresa esperándote. Tu jardín lo agradece 🌱`,
        }
      }
    } else if (e.porReclamar > 0) {
      aviso = {
        title: `🎁 Tienes ${e.porReclamar} cofre${e.porReclamar === 1 ? '' : 's'} sin abrir`,
        body: 'Completaste misiones hoy — entra a reclamar tu recompensa antes de medianoche.',
      }
    } else if (e.pendientes > 0 && u.streakActual > 0 && u.streakUltimoCheck?.toISOString().slice(0, 10) !== hoyUTC) {
      aviso = {
        title: `🔥 No pierdas tu racha de ${u.streakActual} día${u.streakActual === 1 ? '' : 's'}`,
        body: 'Completa una misión hoy (un gasto, un pago o una categoría) y tu racha sigue viva.',
      }
    }

    if (!aviso) continue
    emitToUser(u.id, SOCKET_EVENTS.MISSION_REMINDER, { message: aviso.title, detalle: aviso.body, route: '/misiones' })
    await pushMissionReminder(u.id, aviso.title, aviso.body).catch(() => {})
    enviados++
  }
  return enviados
}

export function initMissionRemindersCron() {
  const programar = (expr: string, momento: Momento) =>
    cron.schedule(expr, async () => {
      try {
        const n = await runMissionReminders(momento)
        console.log(`[Cron] Recordatorios de misiones (${momento}) enviados: ${n}`)
      } catch (error) {
        console.error('[Cron] Error en recordatorios de misiones:', error)
      }
    }, { timezone: 'America/Bogota' })

  programar('30 10 * * *', 'manana')
  programar('30 18 * * *', 'tarde')
  console.log('[Cron] Recordatorios de misiones programados (10:30 AM y 6:30 PM)')
}
