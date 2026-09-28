/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Recordatorios de "Me deben"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * La persona que debe no usa Kiri, así que el recordatorio es para QUIEN
 * PRESTÓ: le avisa para que cobre (desde la app puede abrir WhatsApp con el
 * mensaje ya redactado). Corre a las 9:15 AM, después de los avisos de
 * obligaciones propias (9:00), para no juntarlos en el mismo minuto:
 *   - 1 día antes de la fecha prometida
 *   - el día prometido
 *   - al día siguiente si no pagó, y luego cada 7 días mientras siga vencido
 */
import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { sendPushToUser } from '../lib/push.js'

const DIA = 86_400_000

/** Días entre hoy (local) y una fecha guardada como DATE (medianoche UTC). */
function diasHasta(fecha: Date, hoy: Date): number {
  const objetivo = new Date(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate())
  const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  return Math.round((objetivo.getTime() - base.getTime()) / DIA)
}

export async function runExternalLoanReminders(now: Date = new Date()): Promise<number> {
  const loans = await prisma.externalLoan.findMany({
    where: { estado: 'activo', fechaCompromiso: { not: null } },
    select: { userId: true, persona: true, saldoPendiente: true, fechaCompromiso: true },
  })
  let enviados = 0
  for (const l of loans) {
    const d = diasHasta(l.fechaCompromiso!, now)
    const monto = `$${Math.round(Number(l.saldoPendiente)).toLocaleString('es-CO')}`
    let payload: { title: string; body: string } | null = null
    if (d === 1) payload = { title: `💸 Mañana ${l.persona} te paga`, body: `Quedó de pagarte ${monto} mañana.` }
    else if (d === 0) payload = { title: `💸 Hoy ${l.persona} te paga ${monto}`, body: 'Si ya te pagó, regístralo en Kiri. Si no, puedes recordarle por WhatsApp.' }
    else if (d < 0 && (d === -1 || -d % 7 === 0)) payload = { title: `⏰ ${l.persona} te debe ${monto}`, body: `Lleva ${-d} día${d === -1 ? '' : 's'} de retraso. Recuérdale desde Kiri con un toque.` }
    if (!payload) continue
    await sendPushToUser(l.userId, { ...payload, tag: `me-deben-${l.persona}`, url: '/obligaciones?tab=me_deben' }).catch(() => {})
    enviados++
  }
  return enviados
}

export function initExternalLoansCron() {
  cron.schedule('15 9 * * *', async () => {
    try {
      const n = await runExternalLoanReminders()
      console.log(`[Cron] Recordatorios "Me deben" enviados: ${n}`)
    } catch (error) {
      console.error('[Cron] Error en recordatorios "Me deben":', error)
    }
  }, { timezone: 'America/Bogota' })

  console.log('[Cron] Recordatorios "Me deben" programados (9:15 AM diario)')
}
