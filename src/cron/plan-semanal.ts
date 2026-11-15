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
import { avisarFinDePrueba } from '../lib/prueba-plus.js'

export function initPlanSemanalCron() {
  cron.schedule('30 8 * * *', async () => {
    try {
      const n = await cerrarSemanasVencidas()
      console.log(`[Cron] Plan semanal: ${n} semanas cerradas`)
    } catch (error) {
      console.error('[Cron] Error cerrando semanas del plan:', error)
    }
  }, { timezone: 'America/Bogota' })
  // Prueba de KIRI PLUS: aviso 2 días antes de terminar y el día que termina
  cron.schedule('0 9 * * *', async () => {
    try {
      const n = await avisarFinDePrueba()
      console.log(`[Cron] Prueba de PLUS: ${n} avisos`)
    } catch (error) {
      console.error('[Cron] Error avisando fin de prueba:', error)
    }
  }, { timezone: 'America/Bogota' })
  console.log('[Cron] Cierre del plan semanal programado (8:30 AM) y avisos de fin de prueba (9:00 AM)')
}
