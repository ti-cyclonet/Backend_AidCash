/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Invitaciones por enlace
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Cada usuario tiene un enlace por tipo de relación (Amigo / Familia / Pareja).
 * Quien se registra con él queda conectado en Social con quien lo invitó — ya
 * aceptado, con ese rol, sin buscar usernames ni aceptar solicitudes — y le
 * suma a las misiones de referidos de quien invitó (ver missions.ts).
 *
 * Si quien abre el enlace ya tenía cuenta, puede usarlo igual para conectarse
 * directo (el enlace ya es el "sí" de quien invita), pero eso no cuenta como
 * referido: las misiones son por traer gente NUEVA a Kiri.
 */
import { randomBytes } from 'crypto'
import type { ConnectionRole } from '@prisma/client'
import { prisma } from '../config/database.js'
import { emitToUser, SOCKET_EVENTS } from './socket.js'
import { pushReferralJoined, pushInviteAccepted } from './push.js'
import { recordOnboardingAction } from './missions.js'
import { DESCUENTO_INVITADO } from './planes.js'
import { darPruebaInvitado, premiarPagoDeReferido, contarAmigos, textoFalta, PRUEBA_INVITADO_DIAS, BONO_ACTIVACION, textoBono } from './referidos.js'

const ROLE_LABEL: Record<ConnectionRole, string> = { FRIEND: 'amigo', FAMILY: 'familia', PARTNER: 'pareja' }

/** Código corto, legible y sin caracteres ambiguos (0/O, 1/l/I). */
function nuevoCodigo(): string {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(8)
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('')
}

export async function obtenerEnlace(inviterId: string, role: ConnectionRole) {
  const existente = await prisma.inviteLink.findUnique({ where: { inviterId_role: { inviterId, role } } })
  if (existente) return existente
  for (let intento = 0; intento < 5; intento++) {
    try {
      return await prisma.inviteLink.create({ data: { inviterId, role, code: nuevoCodigo() } })
    } catch (e) {
      // Colisión de código (o carrera creando el mismo rol) — reintentar
      const otro = await prisma.inviteLink.findUnique({ where: { inviterId_role: { inviterId, role } } })
      if (otro) return otro
      if (intento === 4) throw e
    }
  }
  throw new Error('No se pudo crear el enlace')
}

export async function infoPublicaEnlace(code: string) {
  const link = await prisma.inviteLink.findUnique({
    where: { code: code.trim().toLowerCase() },
    include: { inviter: { select: { id: true, nombre: true, username: true, avatarUrl: true } } },
  })
  if (!link) return null
  return { code: link.code, role: link.role, inviter: link.inviter }
}

/**
 * Pareja es exclusiva (una sola por usuario, igual que en /connections/invite):
 * si alguno ya tiene pareja, la conexión queda como Amigo en vez de fallar.
 */
async function rolEfectivo(role: ConnectionRole, a: string, b: string): Promise<ConnectionRole> {
  if (role !== 'PARTNER') return role
  const yaTiene = await prisma.connection.findFirst({
    where: { status: 'ACCEPTED', role: 'PARTNER', OR: [{ requesterId: { in: [a, b] } }, { addresseeId: { in: [a, b] } }] },
  })
  return yaTiene ? 'FRIEND' : 'PARTNER'
}

type ResultadoConexion =
  | { ok: true; role: ConnectionRole; inviter: { id: string; nombre: string }; yaConectados: boolean }
  | { ok: false; error: string; status: number }

/** Conecta a `userId` con quien creó el enlace (ACEPTADA de una). */
async function conectar(code: string, userId: string): Promise<ResultadoConexion> {
  const link = await prisma.inviteLink.findUnique({
    where: { code: code.trim().toLowerCase() },
    include: { inviter: { select: { id: true, nombre: true } } },
  })
  if (!link) return { ok: false, error: 'Este enlace de invitación no existe', status: 404 }
  if (link.inviterId === userId) return { ok: false, error: 'Este es tu propio enlace de invitación', status: 400 }

  const existente = await prisma.connection.findFirst({
    where: { OR: [{ requesterId: link.inviterId, addresseeId: userId }, { requesterId: userId, addresseeId: link.inviterId }] },
  })
  if (existente?.status === 'ACCEPTED') {
    return { ok: true, role: existente.role, inviter: link.inviter, yaConectados: true }
  }

  const role = await rolEfectivo(link.role, link.inviterId, userId)
  if (existente) {
    // Había una solicitud pendiente o rechazada entre ellos: el enlace manda.
    await prisma.connection.update({ where: { id: existente.id }, data: { status: 'ACCEPTED', role } })
  } else {
    await prisma.connection.create({ data: { requesterId: link.inviterId, addresseeId: userId, status: 'ACCEPTED', role } })
  }
  return { ok: true, role, inviter: link.inviter, yaConectados: false }
}

/**
 * Registro con enlace (solo cuentas NUEVAS): conecta en Social, marca quién lo
 * invitó y suma el uso. La misión de invitar y el aviso a quien invitó se
 * acreditan cuando la cuenta queda activa (correo verificado) — así no cuenta
 * un registro a medias ni uno que nunca se verificó. Nunca hace fallar el registro.
 */
export async function aplicarInvitacionAlRegistro(code: string, nuevoUsuarioId: string, _nombreNuevo: string): Promise<void> {
  try {
    const r = await conectar(code, nuevoUsuarioId)
    if (!r.ok) return
    await prisma.$transaction([
      prisma.user.update({ where: { id: nuevoUsuarioId }, data: { invitedById: r.inviter.id } }),
      prisma.inviteLink.update({ where: { code: code.trim().toLowerCase() }, data: { usos: { increment: 1 } } }),
    ])
    const nuevo = await prisma.user.findUnique({ where: { id: nuevoUsuarioId }, select: { isActive: true } })
    if (nuevo?.isActive) await acreditarReferido(nuevoUsuarioId)
  } catch (error) {
    console.error('[Invitacion] Error al aplicar enlace en registro:', error)
  }
}

/**
 * La persona invitada ya tiene su cuenta activa: avanza la misión de invitar
 * de quien la invitó y le avisa. Es idempotente para la misión (se cuenta con
 * los referidos activos reales).
 */
export async function acreditarReferido(nuevoUsuarioId: string): Promise<void> {
  try {
    const nuevo = await prisma.user.findUnique({ where: { id: nuevoUsuarioId }, select: { nombre: true, invitedById: true, isActive: true } })
    if (!nuevo?.invitedById || !nuevo.isActive) return
    const inviterId = nuevo.invitedById
    const conn = await prisma.connection.findFirst({
      where: { OR: [{ requesterId: inviterId, addresseeId: nuevoUsuarioId }, { requesterId: nuevoUsuarioId, addresseeId: inviterId }] },
      select: { role: true },
    })
    const role = conn?.role ?? 'FRIEND'
    await recordOnboardingAction(inviterId, 'invitar_amigo')

    // El invitado: 14 días de KIRI PLUS gratis (una sola vez). Quien invita
    // gana cuando el amigo empiece a usar Kiri y cuando pague (lib/referidos.ts).
    const inviter = await prisma.user.findUnique({ where: { id: inviterId }, select: { nombre: true } })
    await darPruebaInvitado(nuevoUsuarioId, inviter?.nombre)
    const c = await contarAmigos(inviterId)
    emitToUser(inviterId, SOCKET_EVENTS.REFERRAL_JOINED, {
      nombre: nuevo.nombre,
      role,
      message: `¡${nuevo.nombre} entró con tu enlace! Ya está en tus conexiones como ${ROLE_LABEL[role]}. Cuando registre sus primeros movimientos, los dos ganan ${textoBono(BONO_ACTIVACION)} de Kiri Coach. ${textoFalta(c)}`,
      route: '/mi-plan#invita',
    })
    pushReferralJoined(inviterId, nuevo.nombre, ROLE_LABEL[role]).catch(() => {})
  } catch (error) {
    console.error('[Invitacion] Error al acreditar referido:', error)
  }
}

/** Usuario que YA tenía cuenta y abre el enlace: se conecta directo. */
export async function aceptarEnlaceExistente(code: string, userId: string): Promise<ResultadoConexion> {
  const r = await conectar(code, userId)
  if (r.ok && !r.yaConectados) {
    const yo = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true } })
    pushInviteAccepted(r.inviter.id, yo?.nombre ?? 'Alguien').catch(() => {})
    emitToUser(r.inviter.id, SOCKET_EVENTS.INVITE_ACCEPTED, {
      by: { id: userId, nombre: yo?.nombre },
      role: r.role,
    })
  }
  return r
}

export async function contarReferidos(userId: string): Promise<number> {
  return prisma.user.count({ where: { invitedById: userId, isActive: true } })
}

/** Amigos invitados que ya se suscribieron y pagaron su primera factura. */
export function contarReferidosSuscritos(userId: string): Promise<number> {
  return prisma.user.count({ where: { invitedById: userId, primerPagoEn: { not: null } } })
}

/**
 * `userId` pagó una factura de Kiri. La primera vez: queda marcado como
 * suscrito y, si llegó invitado, quien lo invitó gana 1 mes gratis de su plan
 * (sin tope de amigos) y se revisan sus niveles (lib/referidos.ts).
 * Idempotente: una segunda factura pagada no vuelve a premiar.
 */
export async function premiarReferidoPorPago(userId: string): Promise<{ premiado: boolean; inviterId?: string; premio?: string }> {
  // Marca atómica: solo la primera factura pagada pasa de null a fecha
  const marcado = await prisma.user.updateMany({ where: { id: userId, primerPagoEn: null }, data: { primerPagoEn: new Date(), descuentoReferidoUsado: true } })
  if (marcado.count === 0) return { premiado: false }
  return premiarPagoDeReferido(userId)
}

/** Texto corto de lo que gana el amigo, para los mensajes de invitación. */
export const OFERTA_AMIGO = `${PRUEBA_INVITADO_DIAS} días de KIRI PLUS gratis y ${DESCUENTO_INVITADO.PLUS}% en su primer mes`
