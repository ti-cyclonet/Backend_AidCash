/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Minijuego del Árbol Kiri
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tres cosas para volver cada día, todas ligadas a la plata real y validadas
 * aquí (el cliente solo anima; nunca decide cuánta XP gana):
 *
 *  - Frutos (desde el nivel 4): caen al pie del árbol, 1 por visitarlo y 1 más
 *    por cada movimiento real de hoy (gasto, ingreso, pago, ahorro), hasta 5. Tocarlos
 *    los cosecha (+3 XP; ~1 de cada 5 sale dorado: +10 XP). Los que no se
 *    cosechan se caen a medianoche.
 *  - Sacudida: una vez al día, sacudir el árbol suelta un premio sorpresa.
 *  - Riego: una vez al día, regar el árbol da +5 XP.
 *  - 50 toques: una vez al día, tocar el árbol 50 veces seguidas (el cliente reinicia la cuenta si se para)
 *    suelta un premio mayor que la sacudida.
 *
 * Con el boost de XP x2 activo (cofres de misiones o la sacudida) todo vale doble.
 * La XP queda en User.xpFromJardin y suma al XP total del árbol.
 */
import { createHash } from 'crypto'
import { prisma } from '../config/database.js'
import { todayPeriodo } from './missions.js'

export const FRUTOS = { porVisita: 1, maximo: 5, xp: 3, xpDorado: 10 }
export const XP_RIEGO = 5
/** Los frutos salen desde el nivel 4 ("Árbol en crecimiento"): antes no hay copa que los dé */
export const NIVEL_FRUTOS = { nivel: 4, xp: 4350 }

/**
 * XP total del árbol — MISMA fórmula que Frontend_AidCash/src/lib/garden-xp.ts
 * (40 acumulados por cada día de racha, 50 por insignia, más misiones, riegos de
 * amigos y minijuego). Solo sube: perder la racha no baja de nivel.
 */
export async function xpDelArbol(userId: string): Promise<number> {
  const [u, insignias] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { xpFromRacha: true, xpFromMissions: true, xpFromWatering: true, xpFromJardin: true } }),
    prisma.userBadge.count({ where: { userId } }),
  ])
  if (!u) return 0
  return u.xpFromRacha + insignias * 50 + u.xpFromMissions + u.xpFromWatering + u.xpFromJardin
}

interface PremioSacudida { tipo: 'xp' | 'boost'; valor: number; peso: number; etiqueta: string; icono: string }
const PREMIOS_SACUDIDA: PremioSacudida[] = [
  { tipo: 'xp', valor: 2, peso: 35, etiqueta: '+2 XP', icono: '🍃' },
  { tipo: 'xp', valor: 5, peso: 30, etiqueta: '+5 XP', icono: '🍎' },
  { tipo: 'xp', valor: 10, peso: 18, etiqueta: '+10 XP', icono: '🍐' },
  { tipo: 'xp', valor: 20, peso: 10, etiqueta: '+20 XP', icono: '🌟' },
  { tipo: 'boost', valor: 2, peso: 5, etiqueta: 'XP x2 por 2 horas', icono: '⚡' },
  { tipo: 'xp', valor: 50, peso: 2, etiqueta: '¡Premio mayor! +50 XP', icono: '💎' },
]

/** Premio por tocar el árbol 50 veces seguidas: siempre mejor que la sacudida. */
export const TOQUES_PREMIO = 50
const PREMIOS_TOQUES: PremioSacudida[] = [
  { tipo: 'xp', valor: 15, peso: 40, etiqueta: '+15 XP', icono: '🍊' },
  { tipo: 'xp', valor: 25, peso: 30, etiqueta: '+25 XP', icono: '🍇' },
  { tipo: 'xp', valor: 40, peso: 15, etiqueta: '+40 XP', icono: '🌟' },
  { tipo: 'boost', valor: 3, peso: 10, etiqueta: 'XP x2 por 3 horas', icono: '⚡' },
  { tipo: 'xp', valor: 100, peso: 5, etiqueta: '¡Premio mayor! +100 XP', icono: '💎' },
]

function inicioDeHoy(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** ¿Este fruto sale dorado? Fijo por usuario, día y posición (~20%), no se puede "re-tirar". */
export function esDorado(userId: string, fecha: string, indice: number): boolean {
  return createHash('sha256').update(`${userId}:${fecha}:${indice}`).digest()[0] < 52
}

async function movimientosDeHoy(userId: string): Promise<number> {
  const desde = inicioDeHoy()
  const filas = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM (
      SELECT created_at FROM impulse_expenses WHERE user_id = ${userId} AND created_at >= ${desde}
      UNION ALL SELECT created_at FROM income_records WHERE user_id = ${userId} AND created_at >= ${desde}
      UNION ALL SELECT created_at FROM savings_history WHERE user_id = ${userId} AND tipo = 'ahorro' AND created_at >= ${desde}
      UNION ALL SELECT dp.created_at FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id WHERE d.user_id = ${userId} AND dp.created_at >= ${desde}
      UNION ALL SELECT fp.created_at FROM fixed_expense_payments fp JOIN fixed_expenses f ON f.id = fp.fixed_expense_id WHERE f.user_id = ${userId} AND fp.created_at >= ${desde}
    ) t`
  return filas[0]?.n ?? 0
}

async function boostActivo(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { xpBoostExpiresAt: true } })
  return !!(u?.xpBoostExpiresAt && u.xpBoostExpiresAt.getTime() > Date.now())
}

/** Lo que hay hoy en el jardín para jugar. */
export async function estadoJardin(userId: string) {
  const fecha = todayPeriodo()
  const [movimientos, hoy, user, boost, xp] = await Promise.all([
    movimientosDeHoy(userId),
    prisma.gardenCosecha.findMany({ where: { userId, fecha } }),
    prisma.user.findUnique({ where: { id: userId }, select: { xpFromJardin: true } }),
    boostActivo(userId),
    xpDelArbol(userId),
  ])
  const frutosDesbloqueados = xp >= NIVEL_FRUTOS.xp
  const disponibles = frutosDesbloqueados ? Math.min(FRUTOS.maximo, FRUTOS.porVisita + movimientos) : 0
  const cosechados = new Set(hoy.filter(c => c.tipo === 'fruto').map(c => c.indice))
  const sacudida = hoy.find(c => c.tipo === 'sacudida')
  const toques = hoy.find(c => c.tipo === 'toques')
  return {
    fecha,
    frutos: Array.from({ length: disponibles }, (_, i) => ({ indice: i, dorado: esDorado(userId, fecha, i), cosechado: cosechados.has(i) })),
    frutosMaximo: FRUTOS.maximo,
    // Antes del nivel 4 el árbol no da frutos (sacudida y riego sí)
    frutosDesbloqueados,
    nivelFrutos: NIVEL_FRUTOS.nivel,
    // Cuántos frutos más puede dar hoy registrando movimientos
    frutosPorGanar: frutosDesbloqueados ? FRUTOS.maximo - disponibles : 0,
    xpFruto: FRUTOS.xp,
    xpDorado: FRUTOS.xpDorado,
    sacudida: sacudida ? { etiqueta: sacudida.detalle ?? `+${sacudida.xp} XP`, xp: sacudida.xp } : null,
    toquesPremio: TOQUES_PREMIO,
    premioToques: toques ? { etiqueta: toques.detalle ?? `+${toques.xp} XP`, xp: toques.xp } : null,
    regado: hoy.some(c => c.tipo === 'riego'),
    xpRiego: XP_RIEGO,
    xpHoy: hoy.reduce((a, c) => a + c.xp, 0),
    xpJardin: user?.xpFromJardin ?? 0,
    boost,
  }
}

type Resultado<T> = { ok: true } & T | { ok: false; error: string; status: number }

/** Guarda la cosecha del día (única por tipo/índice) y suma la XP. false si ya existía. */
async function guardar(userId: string, fecha: string, tipo: string, indice: number, xp: number, detalle?: string): Promise<boolean> {
  if (await prisma.gardenCosecha.findUnique({ where: { userId_fecha_tipo_indice: { userId, fecha, tipo, indice } }, select: { id: true } })) return false
  try {
    await prisma.$transaction([
      prisma.gardenCosecha.create({ data: { userId, fecha, tipo, indice, xp, detalle } }),
      prisma.user.update({ where: { id: userId }, data: { xpFromJardin: { increment: xp } } }),
    ])
    return true
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return false
    throw e
  }
}

export async function cosecharFruto(userId: string, indice: number): Promise<Resultado<{ xp: number; dorado: boolean; doble: boolean }>> {
  const fecha = todayPeriodo()
  if (await xpDelArbol(userId) < NIVEL_FRUTOS.xp) {
    return { ok: false, error: 'Tu árbol da frutos desde el nivel 4. ¡Sigue cuidándolo!', status: 403 }
  }
  const disponibles = Math.min(FRUTOS.maximo, FRUTOS.porVisita + await movimientosDeHoy(userId))
  if (!Number.isInteger(indice) || indice < 0 || indice >= disponibles) {
    return { ok: false, error: 'Ese fruto todavía no ha crecido. Registra un movimiento y sale otro.', status: 400 }
  }
  const dorado = esDorado(userId, fecha, indice)
  const doble = await boostActivo(userId)
  const xp = (dorado ? FRUTOS.xpDorado : FRUTOS.xp) * (doble ? 2 : 1)
  if (!await guardar(userId, fecha, 'fruto', indice, xp)) return { ok: false, error: 'Ya cosechaste este fruto hoy', status: 409 }
  return { ok: true, xp, dorado, doble }
}

function elegirPremio(premios: PremioSacudida[] = PREMIOS_SACUDIDA): PremioSacudida {
  const total = premios.reduce((a, p) => a + p.peso, 0)
  let r = Math.random() * total
  for (const p of premios) {
    if (r < p.peso) return p
    r -= p.peso
  }
  return premios[0]
}

type PremioEntregado = { tipo: 'xp' | 'boost'; xp: number; etiqueta: string; icono: string }

/** Sortea un premio de la tabla, lo guarda (1 por día y tipo) y activa el boost si salió. */
async function entregarPremio(userId: string, tipoCosecha: string, premios: PremioSacudida[], yaReclamado: string): Promise<Resultado<PremioEntregado>> {
  const fecha = todayPeriodo()
  const p = elegirPremio(premios)
  const doble = p.tipo === 'xp' && await boostActivo(userId)
  const xp = p.tipo === 'xp' ? p.valor * (doble ? 2 : 1) : 0
  const etiqueta = doble ? `${p.etiqueta} (x2)` : p.etiqueta
  if (!await guardar(userId, fecha, tipoCosecha, 0, xp, etiqueta)) {
    return { ok: false, error: yaReclamado, status: 409 }
  }
  if (p.tipo === 'boost') {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { xpBoostExpiresAt: true } })
    const desde = u?.xpBoostExpiresAt && u.xpBoostExpiresAt > new Date() ? u.xpBoostExpiresAt : new Date()
    await prisma.user.update({ where: { id: userId }, data: { xpBoostExpiresAt: new Date(desde.getTime() + p.valor * 3_600_000) } })
  }
  return { ok: true, tipo: p.tipo, xp, etiqueta, icono: p.icono }
}

export function sacudirArbol(userId: string) {
  return entregarPremio(userId, 'sacudida', PREMIOS_SACUDIDA, 'Ya sacudiste tu árbol hoy. Vuelve mañana por otro premio.')
}

/** Los 50 toques los cuenta el cliente; el servidor solo deja reclamarlo una vez al día. */
export function premioToques(userId: string) {
  return entregarPremio(userId, 'toques', PREMIOS_TOQUES, 'Ya ganaste el premio de los 50 toques hoy. Vuelve mañana.')
}

export async function regarArbol(userId: string): Promise<Resultado<{ xp: number }>> {
  const fecha = todayPeriodo()
  const xp = XP_RIEGO * (await boostActivo(userId) ? 2 : 1)
  if (!await guardar(userId, fecha, 'riego', 0, xp)) return { ok: false, error: 'Ya regaste tu árbol hoy', status: 409 }
  return { ok: true, xp }
}
