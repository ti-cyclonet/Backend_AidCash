/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Vencimiento de deudas y gastos fijos
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Distinto del cron de "día de pago" (payment-notifications.ts, que avisa cuando
 * se acerca TU sueldo) — este avisa cuando se acerca la fecha de vencimiento de
 * CADA deuda o gasto fijo individual, usando su propio `diasPago`/`fechaCorte`.
 *
 * Se ejecuta todos los días a las 9:00 AM (una hora después del cron de sueldo,
 * para no competir por el mismo minuto):
 *   - 2 días antes / 1 día antes / el día que vence: recordatorio, solo si sigue
 *     pendiente en el periodo actual (usando el ledger de pagos, no una columna).
 *   - El día siguiente al vencimiento, si sigue sin pagarse: aviso de vencido,
 *     una sola vez (el cron corre una vez al día, así que no se repite).
 */

import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { daysUntilDayOfMonth } from '../lib/date-helpers.js'
import { pushObligationDue, pushObligationOverdue } from '../lib/push.js'
import { parseDays as parseDaysShared, fixedExpenseDay, isDebtPending, isFixedExpensePending, isDayAfter } from '../lib/obligation-schedule.js'

const parseDays = parseDaysShared

export function initObligationDueDatesCron() {
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Ejecutando notificaciones de vencimiento de obligaciones...')

    try {
      const now = new Date()
      const today = now.getDate()
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)

      const [debts, fixedExpenses] = await Promise.all([
        prisma.debt.findMany({ where: { estado: 'activa' } }),
        prisma.fixedExpense.findMany(),
      ])

      const [debtPayments, fixedPayments] = await Promise.all([
        debts.length > 0
          ? prisma.debtPayment.findMany({ where: { debtId: { in: debts.map(d => d.id) }, createdAt: { gte: fortyDaysAgo } } })
          : Promise.resolve([]),
        fixedExpenses.length > 0
          ? prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: { in: fixedExpenses.map(f => f.id) }, createdAt: { gte: fortyDaysAgo } } })
          : Promise.resolve([]),
      ])

      let notified = 0

      for (const debt of debts) {
        if (!isDebtPending(debt, debtPayments)) continue
        const days = parseDays(debt.diasPago)
        if (days.length === 0) continue

        if (isDayAfter(today, days, daysInMonth)) {
          await pushObligationOverdue(debt.userId, debt.nombre)
          notified++
          continue
        }

        const minDaysLeft = Math.min(...days.map(d => daysUntilDayOfMonth(today, d, daysInMonth)))
        if (minDaysLeft === 0 || minDaysLeft === 1 || minDaysLeft === 2) {
          await pushObligationDue(debt.userId, debt.nombre, minDaysLeft)
          notified++
        }
      }

      for (const fe of fixedExpenses) {
        if (!isFixedExpensePending(fe, fixedPayments)) continue
        const days = fixedExpenseDay(fe.fechaCorte)
        if (days.length === 0) continue

        if (isDayAfter(today, days, daysInMonth)) {
          await pushObligationOverdue(fe.userId, fe.nombre)
          notified++
          continue
        }

        const minDaysLeft = Math.min(...days.map(d => daysUntilDayOfMonth(today, d, daysInMonth)))
        if (minDaysLeft === 0 || minDaysLeft === 1 || minDaysLeft === 2) {
          await pushObligationDue(fe.userId, fe.nombre, minDaysLeft)
          notified++
        }
      }

      console.log(`[Cron] Notificaciones de vencimiento enviadas: ${notified}`)
    } catch (error) {
      console.error('[Cron] Error en notificaciones de vencimiento:', error)
    }
  }, {
    timezone: 'America/Bogota',
  })

  console.log('[Cron] Obligation due dates programado (9:00 AM diario)')
}
