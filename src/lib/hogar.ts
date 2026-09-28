/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Presupuesto del hogar (categorías compartidas en pareja)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Los dos de una conexión de pareja crean categorías con un tope por periodo
 * (Comida, Salidas, Viajes, Renta…). El periodo es mensual o quincenal
 * (Connection.hogarPeriodo) y lo puede cambiar cualquiera de los dos. Cada uno registra sus gastos normales
 * (ImpulseExpense) y los marca con la categoría del hogar: salen de SU
 * billetera, pero suman al tope compartido. Al otro le llega el aviso
 * (campana + celular) y, al cruzar el 80% / 100%, se les avisa a los dos.
 */
import { prisma } from '../config/database.js'
import { emitToUser, SOCKET_EVENTS } from './socket.js'
import { sendPushToUser } from './push.js'

const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`

/** Conexión de pareja aceptada del usuario (la del hogar). */
export async function conexionHogar(userId: string) {
  const conn = await prisma.connection.findFirst({
    where: { status: 'ACCEPTED', role: 'PARTNER', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    include: {
      requester: { select: { id: true, nombre: true } },
      addressee: { select: { id: true, nombre: true } },
    },
  })
  if (!conn) return null
  const yo = conn.requesterId === userId ? conn.requester : conn.addressee
  const pareja = conn.requesterId === userId ? conn.addressee : conn.requester
  return { connectionId: conn.id, yo, pareja, periodo: (conn.hogarPeriodo === 'quincenal' ? 'quincenal' : 'mensual') as PeriodoHogar }
}

export type PeriodoHogar = 'mensual' | 'quincenal'

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** Rango local del periodo actual: el mes, o la quincena (1–15 / 16–fin). */
export function rangoPeriodo(periodo: PeriodoHogar, now: Date = new Date()) {
  const y = now.getFullYear(), m = now.getMonth()
  const finMes = new Date(y, m + 1, 0).getDate()
  if (periodo === 'mensual') {
    return { desde: new Date(y, m, 1), etiqueta: `1 – ${finMes} ${MESES[m]}`, texto: 'este mes' }
  }
  return now.getDate() <= 15
    ? { desde: new Date(y, m, 1), etiqueta: `1 – 15 ${MESES[m]}`, texto: 'esta quincena' }
    : { desde: new Date(y, m, 16), etiqueta: `16 – ${finMes} ${MESES[m]}`, texto: 'esta quincena' }
}

export async function gastadoCategoria(sharedCategoryId: string, periodo: PeriodoHogar = 'mensual', now: Date = new Date()): Promise<number> {
  const r = await prisma.impulseExpense.aggregate({
    where: { sharedCategoryId, createdAt: { gte: rangoPeriodo(periodo, now).desde } },
    _sum: { monto: true },
  })
  return Number(r._sum.monto ?? 0)
}

export async function resumenHogar(userId: string) {
  const hogar = await conexionHogar(userId)
  if (!hogar) return null
  const categorias = await prisma.sharedBudgetCategory.findMany({
    where: { connectionId: hogar.connectionId },
    orderBy: { createdAt: 'asc' },
  })
  const ids = categorias.map((c) => c.id)
  const rango = rangoPeriodo(hogar.periodo)
  const desde = rango.desde
  const [porUsuario, recientes] = await Promise.all([
    ids.length
      ? prisma.impulseExpense.groupBy({
          by: ['sharedCategoryId', 'userId'],
          where: { sharedCategoryId: { in: ids }, createdAt: { gte: desde } },
          _sum: { monto: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.impulseExpense.findMany({
          where: { sharedCategoryId: { in: ids }, createdAt: { gte: desde } },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { id: true, nombre: true, monto: true, createdAt: true, userId: true, sharedCategoryId: true },
        })
      : Promise.resolve([]),
  ])

  const suma = (catId: string, uid: string) =>
    Number(porUsuario.find((g) => g.sharedCategoryId === catId && g.userId === uid)?._sum.monto ?? 0)

  const lista = categorias.map((c) => {
    const yo = suma(c.id, hogar.yo.id)
    const pareja = suma(c.id, hogar.pareja.id)
    const limite = Number(c.montoLimite)
    const gastado = yo + pareja
    return {
      id: c.id, nombre: c.nombre, icono: c.icono, color: c.color, montoLimite: limite,
      gastado, gastadoYo: yo, gastadoPareja: pareja,
      porcentaje: limite > 0 ? Math.round((gastado / limite) * 100) : 0,
      disponible: Math.max(0, limite - gastado),
    }
  })

  return {
    connectionId: hogar.connectionId,
    pareja: hogar.pareja,
    periodo: hogar.periodo,
    etiquetaPeriodo: rango.etiqueta,
    mes: `${desde.getFullYear()}-${String(desde.getMonth() + 1).padStart(2, '0')}`,
    categorias: lista,
    total: {
      limite: lista.reduce((s, c) => s + c.montoLimite, 0),
      gastado: lista.reduce((s, c) => s + c.gastado, 0),
    },
    recientes: recientes.map((e) => ({
      id: e.id, nombre: e.nombre, monto: Number(e.monto), fecha: e.createdAt,
      quien: e.userId === hogar.yo.id ? 'yo' : 'pareja',
      categoria: lista.find((c) => c.id === e.sharedCategoryId)?.nombre ?? '',
    })),
  }
}

/** ¿Esta categoría del hogar pertenece a la pareja del usuario? */
export async function categoriaDelUsuario(userId: string, sharedCategoryId: string) {
  const hogar = await conexionHogar(userId)
  if (!hogar) return null
  const cat = await prisma.sharedBudgetCategory.findFirst({ where: { id: sharedCategoryId, connectionId: hogar.connectionId } })
  return cat ? { cat, hogar } : null
}

/**
 * Tras registrar un gasto en una categoría del hogar: aviso a la pareja y,
 * si se cruzó el 80% o el 100% del tope con ESTE gasto, aviso a los dos.
 */
export async function avisarGastoHogar(userId: string, sharedCategoryId: string, monto: number, nombreGasto: string) {
  const r = await categoriaDelUsuario(userId, sharedCategoryId)
  if (!r) return null
  const { cat, hogar } = r
  const limite = Number(cat.montoLimite)
  const gastado = await gastadoCategoria(cat.id, hogar.periodo)
  const cuando = rangoPeriodo(hogar.periodo).texto
  const antes = gastado - monto
  const pct = limite > 0 ? Math.round((gastado / limite) * 100) : 0
  const cruzo = limite > 0 && antes < limite && gastado >= limite ? 'excedido'
    : limite > 0 && antes < limite * 0.8 && gastado >= limite * 0.8 ? 'alerta' : null
  const quien = hogar.yo.nombre.split(' ')[0]

  const titulo = `${cat.icono} ${quien} gastó ${fmt(monto)} en ${cat.nombre}`
  const detalle = `"${nombreGasto}" · llevan ${fmt(gastado)} de ${fmt(limite)} ${cuando} (${pct}%).`
  emitToUser(hogar.pareja.id, SOCKET_EVENTS.HOGAR_GASTO, { message: titulo, detalle, route: '/social', categoriaId: cat.id })
  sendPushToUser(hogar.pareja.id, { title: titulo, body: detalle, tag: `hogar-${cat.id}`, url: '/social' }).catch(() => {})

  if (cruzo) {
    const t = cruzo === 'excedido' ? `🚨 Se pasaron en ${cat.nombre}` : `⚠️ Van en el ${pct}% de ${cat.nombre}`
    const b = `Llevan ${fmt(gastado)} de ${fmt(limite)} en el presupuesto del hogar ${cuando}.`
    for (const uid of [hogar.yo.id, hogar.pareja.id]) {
      emitToUser(uid, SOCKET_EVENTS.HOGAR_GASTO, { message: t, detalle: b, route: '/social', categoriaId: cat.id })
      sendPushToUser(uid, { title: t, body: b, tag: `hogar-alerta-${cat.id}`, url: '/social' }).catch(() => {})
    }
  }
  return { categoria: cat.nombre, icono: cat.icono, gastado, limite, porcentaje: pct, alerta: cruzo, periodo: hogar.periodo }
}
