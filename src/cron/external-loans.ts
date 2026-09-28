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
import { avisar } from '../lib/push.js'

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
    await avisar(l.userId, { ...payload, tag: `me-deben-${l.persona}`, url: '/obligaciones?tab=me_deben' }).catch(() => {})
    enviados++
  }
  return enviados
}

/**
 * Préstamos entre usuarios de Kiri (Social): aquí SÍ se le avisa a quien debe
 * (usa Kiri) y también a quien prestó. Mismos momentos que "Me deben".
 */
export async function runSocialLoanReminders(now: Date = new Date(), soloLoans?: string[]): Promise<number> {
  const loans = await prisma.loan.findMany({
    where: { status: 'ACTIVE', fechaCompromiso: { not: null }, ...(soloLoans ? { id: { in: soloLoans } } : {}) },
    select: {
      id: true, lenderId: true, borrowerId: true, remainingAmount: true, fechaCompromiso: true,
      lender: { select: { nombre: true } }, borrower: { select: { nombre: true } },
    },
  })
  let enviados = 0
  for (const l of loans) {
    const d = diasHasta(l.fechaCompromiso!, now)
    const monto = `$${Math.round(Number(l.remainingAmount)).toLocaleString('es-CO')}`
    const lender = l.lender.nombre.split(' ')[0]
    const borrower = l.borrower.nombre.split(' ')[0]
    let aQuienDebe: { title: string; body: string } | null = null
    let aQuienPresto: { title: string; body: string } | null = null
    if (d === 1) {
      aQuienDebe = { title: `💸 Mañana le pagas a ${lender}`, body: `Quedaste de pagarle ${monto} mañana. Regístralo en Social cuando lo hagas.` }
    } else if (d === 0) {
      aQuienDebe = { title: `💸 Hoy le pagas ${monto} a ${lender}`, body: 'Cuando le pagues, registra el abono en Social para que él lo confirme.' }
      aQuienPresto = { title: `💸 Hoy ${borrower} te paga ${monto}`, body: 'Cuando te pague, confirma el abono en Social.' }
    } else if (d < 0 && (d === -1 || -d % 7 === 0)) {
      aQuienDebe = { title: `⏰ Tu pago a ${lender} está atrasado`, body: `Llevas ${-d} día${d === -1 ? '' : 's'} de retraso con ${monto}. Si necesitas más plazo, cambia la fecha en Social.` }
      aQuienPresto = { title: `⏰ ${borrower} te debe ${monto}`, body: `Lleva ${-d} día${d === -1 ? '' : 's'} de retraso con el préstamo.` }
    }
    if (aQuienDebe) { await avisar(l.borrowerId, { ...aQuienDebe, tag: `loan-${l.id}`, tipo: 'prestamo-recordatorio', url: '/social' }).catch(() => {}); enviados++ }
    if (aQuienPresto) { await avisar(l.lenderId, { ...aQuienPresto, tag: `loan-${l.id}`, tipo: 'prestamo-recordatorio', url: '/social' }).catch(() => {}); enviados++ }
  }
  return enviados
}

export function initExternalLoansCron() {
  cron.schedule('15 9 * * *', async () => {
    try {
      const n = await runExternalLoanReminders()
      const m = await runSocialLoanReminders()
      console.log(`[Cron] Recordatorios "Me deben": ${n} · préstamos de Social: ${m}`)
    } catch (error) {
      console.error('[Cron] Error en recordatorios "Me deben":', error)
    }
  }, { timezone: 'America/Bogota' })

  console.log('[Cron] Recordatorios "Me deben" programados (9:15 AM diario)')
}
