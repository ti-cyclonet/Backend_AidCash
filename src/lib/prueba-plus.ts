/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Prueba de KIRI PLUS de bienvenida (2026-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Toda cuenta NUEVA prueba KIRI PLUS 14 días al entrar por primera vez (antes
 * solo los invitados). Así conoce lo que se paga (proyecciones, historial largo,
 * más Kiri Coach) y quiere quedarse. Quien llega invitado no pasa por aquí: su
 * prueba es más larga (30 días, lib/referidos.ts), para que invitar siga valiendo.
 *
 * - Una sola vez por persona (ReferidoPremio clave "prueba_bienvenida").
 * - Solo cuentas creadas desde el lanzamiento: nadie recibe la prueba de golpe.
 * - Quien ya paga un plan no la necesita.
 * - Avisos: 2 días antes de terminar y el día que termina (cron 9:00).
 */
import { prisma } from '../config/database.js'
import { avisar } from './push.js'
import { resolverPlan } from './planes.js'
import { reservarPremio, alargarPrestado } from './referidos.js'
import { registrarEvento } from './plan-eventos.js'

export const PRUEBA_BIENVENIDA_DIAS = 14
export const INICIO_PRUEBA_BIENVENIDA = new Date('2026-11-15T05:00:00.000Z') // 15 nov 2026, 00:00 en Colombia
const DIA = 86400000

/** Da la prueba si corresponde. Idempotente: se puede llamar en cada inicio de sesión. */
export async function darPruebaBienvenida(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, invitedById: true, createdAt: true } })
  if (!u || !u.isActive || u.invitedById || u.createdAt < INICIO_PRUEBA_BIENVENIDA) return false
  if (await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId, clave: 'prueba_bienvenida' } }, select: { id: true } })) return false
  const plan = await resolverPlan(userId)
  if (plan.fuente === 'contrato' || plan.fuente === 'tienda') return false
  const id = await reservarPremio(userId, 'prueba_bienvenida', `${PRUEBA_BIENVENIDA_DIAS} días de KIRI PLUS de bienvenida`)
  if (!id) return false
  await alargarPrestado(userId, 'PLUS', PRUEBA_BIENVENIDA_DIAS)
  registrarEvento(userId, 'prueba_inicio', 'bienvenida', undefined, 'PLUS')
  avisar(userId, {
    title: `Tienes ${PRUEBA_BIENVENIDA_DIAS} días de KIRI PLUS gratis`,
    body: 'Prueba tus proyecciones a 24 meses, el historial largo y Kiri Coach con 150 mensajes. Sin tarjeta.',
    url: '/mi-plan', tag: 'prueba', tipo: 'prueba',
  }).catch(() => {})
  return true
}

export interface EstadoPruebaBienvenida {
  /** La tuvo alguna vez */
  tuvo: boolean
  activa: boolean
  hasta: string | null
  diasRestantes: number
  /** Terminó hace poco (7 días) y no pasó a un plan pago: se le muestra qué tenía */
  recienTerminada: boolean
}

export async function estadoPruebaBienvenida(userId: string, tierActual: string, fuente: string): Promise<EstadoPruebaBienvenida | null> {
  const premio = await prisma.referidoPremio.findFirst({ where: { userId, clave: { in: ['prueba_bienvenida', 'prueba_invitado'] } }, select: { id: true } })
  if (!premio) return null
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { pruebaPlusHasta: true } })
  const hasta = u?.pruebaPlusHasta ?? null
  const ahora = Date.now()
  const activa = !!hasta && hasta.getTime() > ahora
  const pagando = fuente === 'contrato' || fuente === 'tienda'
  return {
    tuvo: true, activa,
    hasta: hasta ? hasta.toISOString() : null,
    diasRestantes: activa ? Math.max(1, Math.ceil((hasta!.getTime() - ahora) / DIA)) : 0,
    recienTerminada: !activa && !!hasta && ahora - hasta.getTime() < 7 * DIA && !pagando && tierActual === 'FREE',
  }
}

/** Cron: avisa 2 días antes del fin y el día que termina. `soloUsuarios` para pruebas. */
export async function avisarFinDePrueba(now: Date = new Date(), soloUsuarios?: string[]): Promise<number> {
  const enDosDias = { gte: new Date(now.getTime() + 1 * DIA), lt: new Date(now.getTime() + 2 * DIA) }
  const terminoHoy = { gte: new Date(now.getTime() - DIA), lt: now }
  const filtro = soloUsuarios ? { id: { in: soloUsuarios } } : {}
  const [porTerminar, terminadas] = await Promise.all([
    prisma.user.findMany({ where: { ...filtro, pruebaPlusHasta: enDosDias, premiosReferido: { some: { clave: { in: ['prueba_bienvenida', 'prueba_invitado'] } } } }, select: { id: true } }),
    prisma.user.findMany({ where: { ...filtro, pruebaPlusHasta: terminoHoy, premiosReferido: { some: { clave: { in: ['prueba_bienvenida', 'prueba_invitado'] } } } }, select: { id: true } }),
  ])
  let n = 0
  for (const { id } of porTerminar) {
    const plan = await resolverPlan(id)
    if (plan.fuente === 'contrato' || plan.fuente === 'tienda') continue
    await avisar(id, { title: 'Te quedan 2 días de KIRI PLUS', body: 'Quédate con tus proyecciones, tu historial de 2 años y Kiri Coach con 150 mensajes. En el plan anual te sale a $11.583 al mes.', url: '/mi-plan', tag: 'prueba', tipo: 'prueba' }).catch(() => {})
    n++
  }
  for (const { id } of terminadas) {
    const plan = await resolverPlan(id)
    if (plan.fuente === 'contrato' || plan.fuente === 'tienda') continue
    await avisar(id, { title: 'Terminó tu prueba de KIRI PLUS', body: 'Todo lo que registraste sigue ahí. Vuelve a PLUS cuando quieras para ver tus proyecciones y tu historial completo.', url: '/mi-plan', tag: 'prueba', tipo: 'prueba' }).catch(() => {})
    n++
  }
  return n
}
