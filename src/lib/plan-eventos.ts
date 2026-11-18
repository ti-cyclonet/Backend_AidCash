/**
 * Medición de los planes (2026-11). Cada cosa que empuja a cambiarse de plan
 * deja un evento con su ORIGEN, para saber qué funciona:
 *   - oferta_vista / oferta_click: una oferta en un buen momento (proyecciones,
 *     semana lograda, historial, Kiri Coach, prueba terminada…)
 *   - limite: chocó con un tope del plan (limite:nCategorias, funcion:p2pLoans, ia:coach)
 *   - cambio_plan: pidió un plan pago (con el origen de la oferta que lo llevó)
 *   - prueba_inicio: empezó la prueba de PLUS de bienvenida
 * Nunca falla ni demora la respuesta. `scripts/metricas-planes.ts` arma el embudo.
 */
import { prisma } from '../config/database.js'
import { resolverPlan } from './planes.js'

export type TipoEvento = 'oferta_vista' | 'oferta_click' | 'limite' | 'cambio_plan' | 'prueba_inicio'
export const TIPOS_EVENTO: TipoEvento[] = ['oferta_vista', 'oferta_click', 'limite', 'cambio_plan', 'prueba_inicio']

const limpiar = (v: unknown, n: number) => String(v ?? '').replace(/[^\w:.\-áéíóúñ ]/gi, '').slice(0, n)

export function registrarEvento(userId: string, tipo: TipoEvento, origen: string, detalle?: string, tier?: string) {
  ;(async () => {
    const t = tier ?? (await resolverPlan(userId).catch(() => null))?.tier ?? 'FREE'
    await prisma.planEvento.create({ data: { userId, tipo, origen: limpiar(origen, 60) || 'desconocido', tier: t, detalle: detalle ? limpiar(detalle, 120) : null } })
  })().catch(() => { /* la medición nunca rompe nada */ })
}
