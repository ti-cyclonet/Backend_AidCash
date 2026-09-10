/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Pago automático en la fecha de vencimiento
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Corre a las 8:30 AM — después del cron de "día de pago" (8:00 AM) y ANTES
 * del cron de notificaciones de vencimiento (9:00 AM), para que algo que se
 * acaba de cobrar automáticamente no dispare además un aviso de "vencido" el
 * mismo día. La lógica real vive en lib/auto-pay.ts (fácil de probar y de
 * reusar sin depender de node-cron).
 */

import cron from 'node-cron'
import { runAutoPay } from '../lib/auto-pay.js'

export function initAutoPayCron() {
  cron.schedule('30 8 * * *', async () => {
    console.log('[Cron] Ejecutando pago automático de obligaciones que vencen hoy...')
    try {
      const summary = await runAutoPay()
      console.log(`[Cron] Pago automático: ${summary.debtsPaid} deudas, ${summary.fixedExpensesPaid} gastos fijos cobrados; ${summary.skippedInsufficientFunds} sin saldo suficiente; ${summary.errors} errores.`)
    } catch (error) {
      console.error('[Cron] Error en pago automático:', error)
    }
  }, {
    timezone: 'America/Bogota',
  })

  console.log('[Cron] Pago automático programado (8:30 AM diario)')
}
