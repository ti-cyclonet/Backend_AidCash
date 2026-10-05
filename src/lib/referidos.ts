/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Programa "Invita y gana"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Antes: el amigo tenía 50% en su primer mes y quien invitaba ganaba 10 días
 * de PLUS solo cuando el amigo PAGABA, hasta 3 amigos. Casi nadie veía un
 * premio (pagar es lento) y a quien ya tenía PRO 10 días de PLUS no le servían.
 *
 * Ahora hay premios en dos momentos y niveles sin tope:
 *
 *  1. El amigo llega con el enlace → 14 días de KIRI PLUS gratis (y, cuando se
 *     suscriba, 50% en su primer mes de PLUS o 30% en PRO, como antes).
 *  2. El amigo se ACTIVA (3 movimientos en 2 días distintos) → los dos ganan
 *     +20 mensajes, +10 dictados y +5 escaneos de Kiri Coach. Barato para
 *     Kiri y se siente al instante.
 *  3. El amigo PAGA su primera factura → quien invitó gana 1 mes gratis de su
 *     plan: si ya paga PLUS o PRO, en su próxima factura (Authoriza); si está
 *     en FREE, 30 días de KIRI PLUS.
 *  4. Niveles por amigos activos (ver NIVELES_REFERIDOS). Los dos más grandes
 *     piden además algunos amigos con plan pago, para que no se puedan ganar
 *     con cuentas falsas.
 *
 * Todo premio queda en ReferidoPremio con una clave única: se entrega una sola
 * vez aunque el evento llegue dos veces. Si Authoriza no responde, el mes
 * gratis queda "pendiente" y se reintenta al abrir Mi plan.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database.js'
import { env } from '../config/env.js'
import { avisar } from './push.js'
import { resolverPlan, invalidarPlan, NOMBRE_PLAN, type Tier } from './planes.js'
import { authorizaInternalHeaders } from './legal.js'
import { periodoIA } from '../middleware/limit-enforcement.js'

// ─── Reglas ──────────────────────────────────────────────────────────────────

export const PRUEBA_INVITADO_DIAS = 14
export const DIAS_MES_GANADO = 30
/** Cuándo un invitado "ya usa Kiri" */
export const ACTIVACION = { movimientos: 3, dias: 2 }

export type BonoIA = { coach?: number; dictado?: number; escaneo?: number }
export const BONO_ACTIVACION: Required<BonoIA> = { coach: 20, dictado: 10, escaneo: 5 }

type PremioNivel =
  | { tipo: 'insignia'; id: string }
  | { tipo: 'bono_ia'; bono: BonoIA }
  | { tipo: 'mes_plan' }
  | { tipo: 'meses_pro'; meses: number }

export interface NivelReferido {
  clave: string
  amigos: number
  /** Además, cuántos de esos amigos deben tener plan pago */
  pagados: number
  titulo: string
  icono: string
  premios: PremioNivel[]
}

/** Sin tope: después del último nivel cada amigo sigue dando su bono y su mes gratis. */
export const NIVELES_REFERIDOS: NivelReferido[] = [
  { clave: 'nivel_1', amigos: 1, pagados: 0, icono: '🌱', titulo: 'Insignia "Primer brote" + 20 mensajes extra de Kiri Coach',
    premios: [{ tipo: 'insignia', id: 'ref_primer_brote' }, { tipo: 'bono_ia', bono: { coach: 20 } }] },
  { clave: 'nivel_3', amigos: 3, pagados: 0, icono: '🎁', titulo: '1 mes gratis de tu plan',
    premios: [{ tipo: 'mes_plan' }] },
  { clave: 'nivel_5', amigos: 5, pagados: 0, icono: '🌳', titulo: 'Insignia "Jardinero social" + 50 mensajes, 20 dictados y 10 escaneos extra',
    premios: [{ tipo: 'insignia', id: 'ref_jardinero_social' }, { tipo: 'bono_ia', bono: { coach: 50, dictado: 20, escaneo: 10 } }] },
  { clave: 'nivel_10', amigos: 10, pagados: 2, icono: '👑', titulo: '3 meses de KIRI PRO + insignia "Embajador Kiri"',
    premios: [{ tipo: 'meses_pro', meses: 3 }, { tipo: 'insignia', id: 'ref_embajador' }] },
  { clave: 'nivel_25', amigos: 25, pagados: 5, icono: '🏆', titulo: 'KIRI PRO por 1 año',
    premios: [{ tipo: 'meses_pro', meses: 12 }] },
]

// ─── Utilidades ──────────────────────────────────────────────────────────────

const DIA = 86_400_000

/** Periodo del bono de IA: este mes, o el siguiente si a este le quedan ≤7 días. */
export function periodoBono(now: Date = new Date()): string {
  const finMes = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  if (finMes - now.getDate() >= 7) return periodoIA(now)
  return periodoIA(new Date(now.getFullYear(), now.getMonth() + 1, 1))
}

export function textoBono(b: BonoIA): string {
  const partes: string[] = []
  if (b.coach) partes.push(`+${b.coach} mensajes`)
  if (b.dictado) partes.push(`+${b.dictado} dictados`)
  if (b.escaneo) partes.push(`+${b.escaneo} escaneos`)
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}` : partes[0] ?? ''
}

/** Usos extra de IA ganados este periodo, por tipo. */
export async function bonosIA(userId: string, periodo: string = periodoIA()): Promise<Record<'coach' | 'dictado' | 'escaneo', number>> {
  const filas = await prisma.aiBono.groupBy({ by: ['tipo'], where: { userId, periodo }, _sum: { cantidad: true } })
  const out = { coach: 0, dictado: 0, escaneo: 0 }
  for (const f of filas) if (f.tipo in out) out[f.tipo as keyof typeof out] = f._sum.cantidad ?? 0
  return out
}

async function darBonoIA(userId: string, bono: BonoIA, motivo: string) {
  const periodo = periodoBono()
  const filas = (['coach', 'dictado', 'escaneo'] as const)
    .filter(t => (bono[t] ?? 0) > 0)
    .map(t => ({ userId, periodo, tipo: t, cantidad: bono[t]!, motivo }))
  if (filas.length) await prisma.aiBono.createMany({ data: filas })
}

/**
 * Reserva el premio ANTES de entregarlo: si la clave ya existe, ya se dio
 * (o se está dando en otra petición) y no se repite.
 */
async function reservarPremio(userId: string, clave: string, premio: string, detalle?: Prisma.InputJsonValue): Promise<string | null> {
  // Lo normal es que ya exista (se revisa en cada movimiento): mirar primero
  // evita llenar el log de errores de llave única
  if (await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId, clave } }, select: { id: true } })) return null
  try {
    const p = await prisma.referidoPremio.create({ data: { userId, clave, premio, detalle } })
    return p.id
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return null
    throw e
  }
}

/** El plan que de verdad paga (contrato facturable), si paga alguno. */
async function planPagado(userId: string): Promise<Tier | null> {
  const plan = await resolverPlan(userId)
  const tier = plan.fuente === 'contrato' ? plan.tier : plan.tierContrato
  return tier && tier !== 'FREE' && plan.isBillable ? tier : null
}

/** Meses gratis en el contrato pago, en Authoriza. null = no se pudo (caído). */
async function mesesGratisEnFactura(userId: string, meses: number): Promise<{ applied: boolean } | null> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { correo: true } })
    if (!u) return { applied: false }
    const check = await fetch(`${env.AUTHORIZA_API_URL}/api/auth/check-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.correo }),
      signal: AbortSignal.timeout(6000),
    })
    if (!check.ok) return null
    const cd = await check.json() as { exists?: boolean; userId?: string }
    if (!cd.exists || !cd.userId) return { applied: false }
    const r = await fetch(`${env.AUTHORIZA_API_URL}/api/contracts/tenant/${cd.userId}/free-months`, {
      method: 'POST', headers: authorizaInternalHeaders(), body: JSON.stringify({ months: meses, application: 'Kiri' }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    const d = await r.json() as { applied?: boolean }
    return { applied: !!d.applied }
  } catch {
    return null
  }
}

/** Alarga un plan prestado (PLUS o PRO) desde hoy o desde donde termine el actual. */
async function alargarPrestado(userId: string, tier: 'PLUS' | 'PRO', dias: number) {
  const campo = tier === 'PRO' ? 'pruebaProHasta' : 'pruebaPlusHasta'
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { pruebaPlusHasta: true, pruebaProHasta: true } })
  const actual = u?.[campo]
  const desde = actual && actual > new Date() ? actual : new Date()
  await prisma.user.update({ where: { id: userId }, data: { [campo]: new Date(desde.getTime() + dias * DIA) } })
  invalidarPlan(userId)
}

/**
 * "1 mes gratis de tu plan" o "N meses de PRO". Quien ya paga ese plan (o uno
 * mayor) lo recibe como meses gratis en su factura; si no, se le presta el
 * plan en Kiri. Devuelve el texto del premio y si quedó pendiente.
 */
async function darMeses(userId: string, tipo: 'mes_plan' | 'meses_pro', meses: number): Promise<{ texto: string; pendiente: boolean }> {
  const pagado = await planPagado(userId)
  const enFactura = tipo === 'mes_plan' ? !!pagado : pagado === 'PRO'
  if (enFactura) {
    const r = await mesesGratisEnFactura(userId, meses)
    const nombre = NOMBRE_PLAN[tipo === 'mes_plan' ? pagado! : 'PRO']
    const texto = meses === 1 ? `1 mes gratis de ${nombre} en tu próxima factura` : `${meses} meses gratis de ${nombre} en tus facturas`
    if (r === null) return { texto, pendiente: true }
    if (r.applied) return { texto, pendiente: false }
    // Authoriza no encontró un contrato pago propio: se presta el plan en Kiri
  }
  if (tipo === 'meses_pro') {
    await alargarPrestado(userId, 'PRO', meses * DIAS_MES_GANADO)
    return { texto: meses === 12 ? 'KIRI PRO por 1 año' : `${meses} meses de KIRI PRO`, pendiente: false }
  }
  await alargarPrestado(userId, 'PLUS', meses * DIAS_MES_GANADO)
  return { texto: `${meses * DIAS_MES_GANADO} días de KIRI PLUS`, pendiente: false }
}

async function darInsignia(userId: string, badgeId: string) {
  await prisma.userBadge.upsert({ where: { userId_badgeId: { userId, badgeId } }, update: {}, create: { userId, badgeId } })
}

/** Campana + celular (tipo "referidos": la app refresca Mi plan al recibirlo). */
function avisarReferido(userId: string, title: string, body: string, url = '/mi-plan#invita') {
  avisar(userId, { title, body, url, tag: 'referidos', tipo: 'referidos' }).catch(() => {})
}

// ─── Conteos y siguiente premio ──────────────────────────────────────────────

export interface ConteoAmigos { invitados: number; activos: number; pagados: number }

export async function contarAmigos(inviterId: string): Promise<ConteoAmigos> {
  const [invitados, activos, pagados] = await Promise.all([
    prisma.user.count({ where: { invitedById: inviterId, isActive: true } }),
    prisma.user.count({ where: { invitedById: inviterId, OR: [{ referidoActivadoEn: { not: null } }, { primerPagoEn: { not: null } }] } }),
    prisma.user.count({ where: { invitedById: inviterId, primerPagoEn: { not: null } } }),
  ])
  return { invitados, activos, pagados }
}

export function siguienteNivel(c: ConteoAmigos) {
  const n = NIVELES_REFERIDOS.find(x => c.activos < x.amigos || c.pagados < x.pagados)
  if (!n) return null
  return { ...n, faltanAmigos: Math.max(0, n.amigos - c.activos), faltanPagados: Math.max(0, n.pagados - c.pagados) }
}

/** "Te falta 1 amigo para: 1 mes gratis de tu plan" (mismo formato que la app, para traducirlo). */
export function textoFalta(c: ConteoAmigos): string {
  const s = siguienteNivel(c)
  if (!s) return 'Ya ganaste todos los niveles: cada amigo nuevo te sigue dando su bono y tu mes gratis.'
  if (s.faltanAmigos > 0) return s.faltanAmigos === 1 ? `Te falta 1 amigo para: ${s.titulo}` : `Te faltan ${s.faltanAmigos} amigos para: ${s.titulo}`
  return s.faltanPagados === 1 ? `Te falta 1 amigo con plan pago para: ${s.titulo}` : `Te faltan ${s.faltanPagados} amigos con plan pago para: ${s.titulo}`
}

// ─── Niveles ─────────────────────────────────────────────────────────────────

/** Entrega los niveles alcanzados que aún no se habían entregado. */
export async function revisarNiveles(inviterId: string): Promise<string[]> {
  const c = await contarAmigos(inviterId)
  const ganados: string[] = []
  for (const n of NIVELES_REFERIDOS) {
    if (c.activos < n.amigos || c.pagados < n.pagados) continue
    const id = await reservarPremio(inviterId, n.clave, n.titulo, { nivel: n.amigos })
    if (!id) continue
    const textos: string[] = []
    let pendiente = false
    for (const p of n.premios) {
      if (p.tipo === 'insignia') await darInsignia(inviterId, p.id)
      else if (p.tipo === 'bono_ia') await darBonoIA(inviterId, p.bono, n.clave)
      else {
        const r = await darMeses(inviterId, p.tipo, p.tipo === 'meses_pro' ? p.meses : 1)
        textos.push(r.texto)
        pendiente ||= r.pendiente
      }
    }
    const premio = textos.length ? n.titulo.replace(/1 mes gratis de tu plan|\d+ meses de KIRI PRO|KIRI PRO por 1 año/, textos[0]) : n.titulo
    await prisma.referidoPremio.update({
      where: { id },
      data: { premio, estado: pendiente ? 'pendiente' : 'entregado', detalle: { nivel: n.amigos, premios: n.premios } as unknown as Prisma.InputJsonValue },
    })
    ganados.push(premio)
    avisarReferido(inviterId, `${n.icono} ¡Nivel de ${n.amigos} ${n.amigos === 1 ? 'amigo' : 'amigos'} en Invita y gana!`, `Ganaste: ${premio}. ${textoFalta(c)}`)
  }
  return ganados
}

// ─── Momento 1: llega con el enlace (cuenta activa) ──────────────────────────

/** 14 días de KIRI PLUS para el invitado nuevo (una sola vez). */
export async function darPruebaInvitado(inviteeId: string, nombreQuienInvita?: string): Promise<boolean> {
  const id = await reservarPremio(inviteeId, 'prueba_invitado', `${PRUEBA_INVITADO_DIAS} días de KIRI PLUS gratis`)
  if (!id) return false
  await alargarPrestado(inviteeId, 'PLUS', PRUEBA_INVITADO_DIAS)
  avisarReferido(
    inviteeId,
    `🎁 Tienes ${PRUEBA_INVITADO_DIAS} días de KIRI PLUS gratis`,
    `${nombreQuienInvita ? `Por llegar con el enlace de ${nombreQuienInvita}. ` : ''}Registra tus primeros movimientos y los dos ganan más mensajes con Kiri Coach.`,
    '/mi-plan',
  )
  return true
}

// ─── Momento 2: el invitado ya usa Kiri ──────────────────────────────────────

async function movimientos(userId: string): Promise<{ n: number; dias: number }> {
  const filas = await prisma.$queryRaw<{ n: number; dias: number }[]>`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT (t.created_at)::date)::int AS dias FROM (
      SELECT created_at FROM impulse_expenses WHERE user_id = ${userId}
      UNION ALL SELECT created_at FROM income_records WHERE user_id = ${userId}
      UNION ALL SELECT created_at FROM savings_history WHERE user_id = ${userId} AND tipo = 'ahorro'
      UNION ALL SELECT dp.created_at FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id WHERE d.user_id = ${userId}
      UNION ALL SELECT fp.created_at FROM fixed_expense_payments fp JOIN fixed_expenses f ON f.id = fp.fixed_expense_id WHERE f.user_id = ${userId}
    ) t`
  return filas[0] ?? { n: 0, dias: 0 }
}

/**
 * Se llama después de cada movimiento real (ver missions.ts). Si quien lo hizo
 * llegó invitado y con esto ya "usa Kiri", los dos ganan el bono de Kiri Coach,
 * avanza el conteo de quien invitó y se revisan sus niveles. Nunca falla.
 */
export async function revisarActivacionReferido(userId: string): Promise<boolean> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true, invitedById: true, isActive: true, referidoActivadoEn: true } })
    if (!u?.invitedById || !u.isActive || u.referidoActivadoEn) return false
    const m = await movimientos(userId)
    if (m.n < ACTIVACION.movimientos || m.dias < ACTIVACION.dias) return false
    return await activar(userId, u.nombre, u.invitedById)
  } catch (error) {
    console.error('[Referidos] Error al revisar activación:', error)
    return false
  }
}

async function activar(userId: string, nombre: string, inviterId: string): Promise<boolean> {
  // Marca atómica: solo una petición pasa de null a fecha
  const marcado = await prisma.user.updateMany({ where: { id: userId, referidoActivadoEn: null }, data: { referidoActivadoEn: new Date() } })
  if (marcado.count === 0) return false

  const bono = textoBono(BONO_ACTIVACION)
  const inviter = await prisma.user.findUnique({ where: { id: inviterId }, select: { nombre: true } })

  if (await reservarPremio(userId, 'bono_activacion', `${bono} de Kiri Coach`)) {
    await darBonoIA(userId, BONO_ACTIVACION, 'activacion')
    avisarReferido(userId, `🎉 Ganaste ${bono} de Kiri Coach`, `Por empezar a usar Kiri con el enlace de ${inviter?.nombre ?? 'tu amigo'}. ${inviter?.nombre ?? 'Tu amigo'} también ganó.`, '/mi-plan')
  }
  if (await reservarPremio(inviterId, `activacion:${userId}`, `${bono} de Kiri Coach`, { amigo: nombre })) {
    await darBonoIA(inviterId, BONO_ACTIVACION, 'activacion')
    const c = await contarAmigos(inviterId)
    avisarReferido(inviterId, `🌱 ${nombre} ya usa Kiri con tu enlace`, `Ganaron los dos ${bono} de Kiri Coach. Llevas ${c.activos} ${c.activos === 1 ? 'amigo activo' : 'amigos activos'}: ${textoFalta(c)}`)
  }
  const { syncReferralMissions } = await import('./missions.js')
  await syncReferralMissions(inviterId)
  await revisarNiveles(inviterId)
  return true
}

/** Revisa a los invitados de alguien que aún no cuentan (al abrir Mi plan). */
export async function ponerAlDiaInvitados(inviterId: string): Promise<void> {
  const pendientes = await prisma.user.findMany({
    where: { invitedById: inviterId, isActive: true, referidoActivadoEn: null },
    select: { id: true }, take: 30, orderBy: { createdAt: 'desc' },
  })
  for (const p of pendientes) await revisarActivacionReferido(p.id)
}

// ─── Momento 3: el invitado paga ─────────────────────────────────────────────

/**
 * El invitado pagó su primera factura (ya marcado en premiarReferidoPorPago):
 * cuenta como activo si aún no lo era, y quien invitó gana 1 mes de su plan.
 */
export async function premiarPagoDeReferido(userId: string): Promise<{ premiado: boolean; inviterId?: string; premio?: string }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true, invitedById: true, referidoActivadoEn: true } })
  if (!u?.invitedById) return { premiado: false }
  const inviterId = u.invitedById
  if (!u.referidoActivadoEn) await activar(userId, u.nombre, inviterId)

  const id = await reservarPremio(inviterId, `pago:${userId}`, '1 mes gratis de tu plan', { amigo: u.nombre })
  if (!id) return { premiado: false, inviterId }
  const r = await darMeses(inviterId, 'mes_plan', 1)
  await prisma.referidoPremio.update({ where: { id }, data: { premio: r.texto, estado: r.pendiente ? 'pendiente' : 'entregado', detalle: { amigo: u.nombre, tipo: 'mes_plan', meses: 1 } } })
  const { syncReferralMissions } = await import('./missions.js')
  await syncReferralMissions(inviterId)
  const c = await contarAmigos(inviterId)
  avisarReferido(inviterId, `🎉 ${u.nombre} se suscribió a Kiri con tu enlace`, `Ganaste ${r.texto}. ${textoFalta(c)}`)
  await revisarNiveles(inviterId)
  return { premiado: true, inviterId, premio: r.texto }
}

/** Reintenta los meses gratis que Authoriza no alcanzó a confirmar. */
export async function reintentarPendientes(userId: string): Promise<void> {
  const pendientes = await prisma.referidoPremio.findMany({ where: { userId, estado: 'pendiente' }, take: 5 })
  for (const p of pendientes) {
    const premios = ((p.detalle as { premios?: PremioNivel[] } | null)?.premios ?? [{ tipo: 'mes_plan' }])
      .filter((x): x is Extract<PremioNivel, { tipo: 'mes_plan' | 'meses_pro' }> => x.tipo === 'mes_plan' || x.tipo === 'meses_pro')
    let pendiente = false
    for (const x of premios) {
      const r = await darMeses(userId, x.tipo, x.tipo === 'meses_pro' ? x.meses : 1)
      pendiente ||= r.pendiente
    }
    if (!pendiente) await prisma.referidoPremio.update({ where: { id: p.id }, data: { estado: 'entregado' } })
  }
}

// ─── Resumen para Mi plan y el jardín ────────────────────────────────────────

// GET /plan se pide seguido: la puesta al día (revisar invitados y reintentar
// meses pendientes) corre como mucho cada 10 minutos por usuario
const ultimaPuestaAlDia = new Map<string, number>()

export async function resumenReferidos(userId: string) {
  const antes = ultimaPuestaAlDia.get(userId) ?? 0
  if (Date.now() - antes > 10 * 60_000) {
    ultimaPuestaAlDia.set(userId, Date.now())
    await ponerAlDiaInvitados(userId).catch(() => {})
    await reintentarPendientes(userId).catch(() => {})
  }
  const [c, premios] = await Promise.all([
    contarAmigos(userId),
    prisma.referidoPremio.findMany({
      where: { userId, NOT: { clave: { in: ['prueba_invitado', 'bono_activacion'] } } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { clave: true, premio: true, estado: true, createdAt: true, detalle: true },
    }),
  ])
  const sig = siguienteNivel(c)
  return {
    ...c,
    niveles: NIVELES_REFERIDOS.map(n => ({
      clave: n.clave, amigos: n.amigos, pagados: n.pagados, titulo: n.titulo, icono: n.icono,
      logrado: c.activos >= n.amigos && c.pagados >= n.pagados,
    })),
    siguiente: sig ? { clave: sig.clave, amigos: sig.amigos, pagados: sig.pagados, titulo: sig.titulo, icono: sig.icono, faltanAmigos: sig.faltanAmigos, faltanPagados: sig.faltanPagados } : null,
    falta: textoFalta(c),
    premios: premios.map(p => ({
      clave: p.clave, premio: p.premio, pendiente: p.estado === 'pendiente', fecha: p.createdAt.toISOString(),
      amigo: (p.detalle as { amigo?: string } | null)?.amigo ?? null,
    })),
    reglas: { pruebaAmigoDias: PRUEBA_INVITADO_DIAS, bonoActivacion: BONO_ACTIVACION, activacion: ACTIVACION },
  }
}
