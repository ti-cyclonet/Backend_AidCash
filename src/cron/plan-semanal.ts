/**
 * Kiri Finance — Cron: cierre del plan semanal
 *
 * Todos los días a las 8:30 AM cierra las semanas del plan que ya terminaron y
 * siguen abiertas (el usuario no abrió la app): calcula lo gastado, abona las
 * monedas si la logró y le avisa. Abrir Billetera también las cierra; nunca se
 * cierran dos veces (ver lib/plan-semanal.ts).
 */
import cron from 'node-cron'
import { cerrarSemanasVencidas } from '../lib/plan-semanal.js'

export function initPlanSemanalCron() {
  cron.schedule('30 8 * * *', async () => {
    try {
      const n = await cerrarSemanasVencidas()
      console.log(`[Cron] Plan semanal: ${n} semanas cerradas`)
    } catch (error) {
      console.error('[Cron] Error cerrando semanas del plan:', error)
    }
  }, { timezone: 'America/Bogota' })
  console.log('[Cron] Cierre del plan semanal programado (8:30 AM)')
}
