/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Economía del Árbol 3D (monedas, tienda y cofres)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * El juego premia lo que el usuario hace con su plata, no tocar la pantalla:
 *  - Ahorrar: +15 monedas (máx. 3 al día). Pagar una obligación: +10 (máx. 5).
 *    Si ese ahorro o pago se elimina el mismo día, las monedas se revierten.
 *  - Saldar una deuda: +30 y un cofre común, una sola vez por deuda.
 *  - Subir de nivel: un cofre raro por nivel (desde el nivel que tenía al
 *    estrenar la economía: no hay cofres retroactivos).
 *  - Regar, sacudir y cosechar dan solo XP (lib/jardin-juego.ts), nunca monedas.
 *  - Con KIRI PLUS o PRO llegan monedas cada mes (una vez por mes, al abrir la tienda).
 *  - Cada día hay una oferta: un artículo que el usuario no tiene con 30 % de descuento.
 *  - Habitantes: personajes de la isla que reaccionan a sus finanzas (el chanchito
 *    viene incluido); se pueden tener varios a la vez.
 *
 * Todo vive aquí: precios, inventario, lo equipado y el sorteo de los cofres.
 * El cliente solo anima. Cada abono queda en CoinLedger con su motivo y su
 * referencia (índice único), así nada se abona dos veces.
 */
import { createHash, randomInt, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database.js'
import { todayPeriodo } from './missions.js'
import { xpDelArbol } from './jardin-juego.js'
import { resolverPlan } from './planes.js'

// ─── Catálogo (los precios viven en el servidor) ─────────────────────────────

export const CATALOGO = {
  especie: { kiri: 0, pino: 600, bonsai: 900, palmera: 1000, cerezo: 1200 },
  color: { auto: 0, esmeralda: 250, menta: 250, bosque: 250, otono: 300, coral: 300, turquesa: 350, sakura: 350, lavanda: 400, morado: 400, noche: 400, carmesi: 450, blanco: 450, atardecer: 550, dorado: 600 },
  hormiguero: { arena: 0, arcilla: 200, piedra: 250, musgo: 300, hongo: 500 },
  cerca: { blanca: 0, madera: 200, bambu: 250, azul: 250, rosa: 250, dorada: 600 },
  regadera: { azul: 0, roja: 200, verde: 200, rosa: 250, cobre: 350, dorada: 550 },
  frutos: { auto: 0, naranja: 200, durazno: 250, limon: 250, ciruela: 300, dorada: 600 },
  habitante: { chanchito: 0, gnomo: 450, pajaros: 800 },
} as const
export type TipoCosmetico = keyof typeof CATALOGO
export const TIPOS = Object.keys(CATALOGO) as TipoCosmetico[]
/** Los "aspectos" que puede soltar un cofre raro o legendario (los colores van aparte). */
const TIPOS_ASPECTO: TipoCosmetico[] = ['especie', 'hormiguero', 'cerca', 'regadera', 'frutos', 'habitante']
/** Los habitantes no ocupan un espacio único: se pueden tener varios en la isla a la vez. */
type Ranura = Exclude<TipoCosmetico, 'habitante'>
const RANURAS = TIPOS.filter((t): t is Ranura => t !== 'habitante')

export type Equipado = Record<Ranura, string> & { habitantes: string[] }
export const EQUIPADO_INICIAL: Equipado = { especie: 'kiri', color: 'auto', hormiguero: 'arena', cerca: 'blanca', regadera: 'azul', frutos: 'auto', habitantes: ['chanchito'] }

/** Monedas de regalo cada mes según el plan (se abonan una vez por mes). */
export const MONEDAS_PLAN: Record<string, number> = { PLUS: 150, PRO: 400 }
const DESCUENTO_OFERTA = 0.3

export const ABONOS = {
  ahorro: { monedas: 15, maxDia: 3 },
  pago: { monedas: 10, maxDia: 5 },
  deuda: { monedas: 30 },
} as const

type TipoCofre = 'comun' | 'raro' | 'legendario'
export const COFRES: Record<TipoCofre, { monedas: [number, number]; aspecto: number; color: number; precio: number; extraSiCompleto: number }> = {
  comun: { monedas: [10, 40], aspecto: 0, color: 0.2, precio: 0, extraSiCompleto: 0 },
  raro: { monedas: [40, 100], aspecto: 0.25, color: 0.3, precio: 0, extraSiCompleto: 0 },
  legendario: { monedas: [60, 120], aspecto: 1, color: 0, precio: 1500, extraSiCompleto: 150 },
}

/**
 * Paquetes de monedas. Se abonan SOLO cuando la tienda confirma el pago (webhook de
 * RevenueCat, routes/pagos.routes.ts). El ID de producto en las tiendas es "kiri_" + id.
 * La primera compra de cada usuario trae el doble de monedas.
 */
export const PAQUETES = [
  { id: 'monedas_250', monedas: 250, precioCop: 2500, bono: 0 },
  { id: 'monedas_600', monedas: 600, precioCop: 4900, bono: 20 },
  { id: 'monedas_1300', monedas: 1300, precioCop: 9900, bono: 30 },
  { id: 'monedas_2800', monedas: 2800, precioCop: 19900, bono: 40 },
]

/** Mismos umbrales de XP que GARDEN_LEVELS en el frontend. */
const NIVELES_XP = [0, 850, 1850, 4350, 8350, 14350]
const nivelDeXp = (xp: number) => NIVELES_XP.filter(u => xp >= u).length

export class EconomiaError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'EconomiaError' }
}

const precio = (tipo: TipoCosmetico, clave: string): number | undefined => (CATALOGO[tipo] as Record<string, number>)[clave]

// ─── Abonos y reversos ───────────────────────────────────────────────────────

/** Mueve monedas y deja la fila en el libro. null si esa referencia ya se abonó. */
async function mover(userId: string, motivo: string, refId: string, delta: number, detalle?: string, tx: Prisma.TransactionClient = prisma) {
  /* skipDuplicates: si esa referencia ya se abonó no inserta nada (sin ensuciar el log con errores) */
  const r = await tx.coinLedger.createMany({ data: [{ userId, motivo, refId, delta, fecha: todayPeriodo(), detalle }], skipDuplicates: true })
  if (r.count === 0) return null
  if (delta >= 0) await tx.user.update({ where: { id: userId }, data: { monedas: { increment: delta } } })
  else await tx.$executeRaw`UPDATE "users" SET "monedas" = GREATEST(0, "monedas" + ${delta}) WHERE "id" = ${userId}`
  return delta
}

/** Cuántos abonos de ese motivo van hoy, sin contar los revertidos. */
async function abonosDeHoy(userId: string, motivo: 'ahorro' | 'pago') {
  const fecha = todayPeriodo()
  const [hechos, revertidos] = await Promise.all([
    prisma.coinLedger.count({ where: { userId, motivo, fecha } }),
    prisma.coinLedger.count({ where: { userId, motivo: 'reverso', fecha, refId: { startsWith: `${motivo}:` } } }),
  ])
  return hechos - revertidos
}

async function abonarConTope(userId: string, motivo: 'ahorro' | 'pago', refId: string) {
  const regla = ABONOS[motivo]
  if (await abonosDeHoy(userId, motivo) >= regla.maxDia) return 0
  return (await mover(userId, motivo, refId, regla.monedas)) ?? 0
}

/** Registrar un ahorro (bolsillo, ahorro libre, fondo de emergencia o aporte compartido aprobado). */
export const abonarAhorro = (userId: string, refId: string) => abonarConTope(userId, 'ahorro', refId)
/** Pagar una obligación (cuota de deuda o gasto fijo, manual o automático). */
export const abonarPago = (userId: string, refId: string) => abonarConTope(userId, 'pago', refId)

/** Si ese ahorro o pago se eliminó el mismo día que se abonó, se devuelven sus monedas. */
export async function revertirAbono(userId: string, motivo: 'ahorro' | 'pago', refId: string) {
  const fila = await prisma.coinLedger.findUnique({ where: { userId_motivo_refId: { userId, motivo, refId } } })
  if (!fila || fila.fecha !== todayPeriodo()) return 0
  return (await mover(userId, 'reverso', `${motivo}:${refId}`, -fila.delta, 'Movimiento eliminado')) ?? 0
}

/** Deuda saldada por completo: +30 monedas y un cofre común, una sola vez por deuda. */
export async function premiarDeudaSaldada(userId: string, debtId: string) {
  const monedas = (await mover(userId, 'deuda', debtId, ABONOS.deuda.monedas)) ?? 0
  await prisma.userChest.createMany({ data: [{ userId, tipo: 'comun', origen: 'deuda', refId: debtId }], skipDuplicates: true })
  return monedas
}

/** Ejecuta un abono sin que un fallo de la economía rompa el ahorro o el pago real. */
export async function sinFallar(etiqueta: string, fn: () => Promise<unknown>) {
  try { await fn() } catch (e) { console.error(`[Economia] ${etiqueta}:`, (e as Error).message) }
}

// ─── Nivel → cofre raro ──────────────────────────────────────────────────────

/** Crea un cofre raro por cada nivel nuevo desde el último premiado. */
export async function revisarNivel(userId: string) {
  const [u, xp] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { jardinNivelPremiado: true } }),
    xpDelArbol(userId),
  ])
  if (!u) return
  const nivel = nivelDeXp(xp)
  // Primera vez: se empieza a contar desde el nivel actual (sin cofres retroactivos)
  if (u.jardinNivelPremiado === null) {
    await prisma.user.update({ where: { id: userId }, data: { jardinNivelPremiado: nivel } })
    return
  }
  if (nivel <= u.jardinNivelPremiado) return
  for (let n = u.jardinNivelPremiado + 1; n <= nivel; n++) {
    await prisma.userChest.createMany({ data: [{ userId, tipo: 'raro', origen: 'nivel', refId: String(n) }], skipDuplicates: true })
  }
  await prisma.user.update({ where: { id: userId }, data: { jardinNivelPremiado: nivel } })
}

// ─── Inventario, tienda y equipar ────────────────────────────────────────────

async function inventario(userId: string) {
  const filas = await prisma.userCosmetic.findMany({ where: { userId }, select: { tipo: true, clave: true } })
  const tiene = new Set(filas.map(f => `${f.tipo}:${f.clave}`))
  const posee = (tipo: TipoCosmetico, clave: string) => precio(tipo, clave) === 0 || tiene.has(`${tipo}:${clave}`)
  return { posee }
}

function leerEquipado(json: Prisma.JsonValue | null): Equipado {
  const e: Equipado = { ...EQUIPADO_INICIAL, habitantes: [...EQUIPADO_INICIAL.habitantes] }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>
    for (const t of RANURAS) {
      const v = o[t]
      if (typeof v === 'string' && precio(t, v) !== undefined) e[t] = v
    }
    if (Array.isArray(o.habitantes)) e.habitantes = [...new Set(o.habitantes.filter((h): h is string => typeof h === 'string' && precio('habitante', h) !== undefined))]
  }
  return e
}

/**
 * Oferta del día: un artículo que no tiene, con descuento. Se elige sobre el catálogo
 * COMPLETO (no sobre lo que le falta): así comprar otra cosa no la cambia; solo pasa
 * al siguiente artículo si compra justo el de la oferta.
 */
function ofertaDelDia(userId: string, posee: (t: TipoCosmetico, c: string) => boolean, fecha = todayPeriodo()) {
  const todos = TIPOS.flatMap(t => Object.entries(CATALOGO[t]).filter(([, p]) => p > 0).map(([clave, p]) => ({ tipo: t, clave, precioNormal: p as number })))
  const n = parseInt(createHash('sha256').update(`${userId}:${fecha}`).digest('hex').slice(0, 8), 16)
  for (let i = 0; i < todos.length; i++) {
    const o = todos[(n + i) % todos.length]
    if (!posee(o.tipo, o.clave)) return { ...o, precio: Math.round(o.precioNormal * (1 - DESCUENTO_OFERTA) / 10) * 10, fecha }
  }
  return null
}

/**
 * Monedas del plan: PLUS y PRO reciben su regalo una vez por mes (la referencia
 * es el mes, así no se repite). Si Authoriza no responde no se abona nada: el
 * próximo intento del mes lo hará.
 */
async function abonarPlanDelMes(userId: string) {
  const plan = await resolverPlan(userId).catch(() => null)
  const monedas = plan && plan.fuente !== 'sin_conexion' ? MONEDAS_PLAN[plan.tier] ?? 0 : 0
  if (!monedas) return { tier: plan?.tier ?? 'FREE', monedas: 0, abonadas: 0 }
  const abonadas = (await mover(userId, 'plan', todayPeriodo().slice(0, 7), monedas, `Regalo ${plan!.tier}`)) ?? 0
  return { tier: plan!.tier, monedas, abonadas }
}

/** Todo lo que necesita la tienda: saldo, catálogo con precios, inventario, equipado y cofres. */
export async function estadoTienda(userId: string) {
  // El regalo del plan pregunta a Authoriza: si tarda, la tienda no lo espera (el abono
  // sigue en segundo plano y se ve en la próxima carga; mover() no lo duplica)
  const sinEsperar = { tier: 'FREE', monedas: 0, abonadas: 0 }
  const regalo = abonarPlanDelMes(userId).catch(() => sinEsperar)
  const [, regaloPlan] = await Promise.all([revisarNivel(userId), Promise.race([regalo, new Promise<typeof sinEsperar>(r => setTimeout(() => r(sinEsperar), 1500))])])
  const [u, { posee }, cofres, ahorrosHoy, pagosHoy] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { monedas: true, jardinEquipado: true } }),
    inventario(userId),
    prisma.userChest.findMany({ where: { userId, estado: 'pendiente' }, orderBy: { createdAt: 'asc' }, select: { id: true, tipo: true, origen: true } }),
    abonosDeHoy(userId, 'ahorro'),
    abonosDeHoy(userId, 'pago'),
  ])
  if (!u) throw new EconomiaError(404, 'Usuario no encontrado.')
  const catalogo = Object.fromEntries(TIPOS.map(t => [t, Object.entries(CATALOGO[t]).map(([clave, p]) => ({ clave, precio: p, incluido: p === 0, tiene: posee(t, clave) }))]))
  return {
    monedas: u.monedas,
    oferta: ofertaDelDia(userId, posee),
    plan: { tier: regaloPlan.tier, monedasMes: regaloPlan.monedas, regaloRecibido: regaloPlan.abonadas, porPlan: MONEDAS_PLAN },
    equipado: leerEquipado(u.jardinEquipado),
    catalogo,
    cofres,
    cofresInfo: Object.entries(COFRES).map(([tipo, c]) => ({
      tipo, monedasMin: c.monedas[0], monedasMax: c.monedas[1], probAspecto: c.aspecto, probColor: c.color, precio: c.precio,
      origen: tipo === 'comun' ? 'deuda' : tipo === 'raro' ? 'nivel' : 'compra',
    })),
    // En la web aún no hay pasarela; en la app nativa se compran con la tienda (el cliente lo decide)
    paquetes: PAQUETES.map(p => ({ ...p, producto: productoDePaquete(p.id), disponible: false })),
    primeraCompraDoble: !(await yaComproMonedas(userId)),
    abonos: {
      ahorro: { monedas: ABONOS.ahorro.monedas, maxDia: ABONOS.ahorro.maxDia, hoy: ahorrosHoy },
      pago: { monedas: ABONOS.pago.monedas, maxDia: ABONOS.pago.maxDia, hoy: pagosHoy },
      deuda: { monedas: ABONOS.deuda.monedas },
    },
  }
}

function validar(tipo: string, clave: string): { tipo: TipoCosmetico; precio: number } {
  if (!TIPOS.includes(tipo as TipoCosmetico)) throw new EconomiaError(400, 'Ese artículo no existe.')
  const p = precio(tipo as TipoCosmetico, clave)
  if (p === undefined) throw new EconomiaError(400, 'Ese artículo no existe.')
  return { tipo: tipo as TipoCosmetico, precio: p }
}

export async function equipar(userId: string, tipoIn: string, clave: string) {
  const { tipo } = validar(tipoIn, clave)
  const [{ posee }, u] = await Promise.all([inventario(userId), prisma.user.findUnique({ where: { id: userId }, select: { jardinEquipado: true } })])
  if (!posee(tipo, clave)) throw new EconomiaError(403, 'Aún no tienes ese artículo.')
  const equipado = leerEquipado(u?.jardinEquipado ?? null)
  // Un habitante se pone o se quita de la isla; el resto reemplaza lo que había en su espacio
  if (tipo === 'habitante') equipado.habitantes = equipado.habitantes.includes(clave) ? equipado.habitantes.filter(h => h !== clave) : [...equipado.habitantes, clave]
  else equipado[tipo] = clave
  await prisma.user.update({ where: { id: userId }, data: { jardinEquipado: equipado } })
  return equipado
}

/** Compra con monedas: descuenta, desbloquea y lo deja equipado, todo en una transacción. */
export async function comprar(userId: string, tipoIn: string, clave: string) {
  const { tipo, precio: normal } = validar(tipoIn, clave)
  if (normal === 0) return equipar(userId, tipo, clave)
  const { posee } = await inventario(userId)
  if (posee(tipo, clave)) throw new EconomiaError(409, 'Ya tienes ese artículo.')
  // La oferta del día se cobra con su descuento (el precio siempre lo decide el servidor)
  const oferta = ofertaDelDia(userId, posee)
  const p = oferta && oferta.tipo === tipo && oferta.clave === clave ? oferta.precio : normal
  await prisma.$transaction(async tx => {
    const cobro = await tx.user.updateMany({ where: { id: userId, monedas: { gte: p } }, data: { monedas: { decrement: p } } })
    if (cobro.count === 0) throw new EconomiaError(402, 'No te alcanzan las monedas.')
    await tx.userCosmetic.create({ data: { userId, tipo, clave, origen: 'compra' } })
    await tx.coinLedger.create({ data: { userId, motivo: 'compra', refId: `${tipo}:${clave}`, delta: -p, fecha: todayPeriodo(), detalle: 'Tienda' } })
  })
  return equipar(userId, tipo, clave)
}

/** El cofre legendario solo se compra, con monedas (nunca con dinero real). */
export async function comprarCofreLegendario(userId: string) {
  const p = COFRES.legendario.precio, id = randomUUID()
  await prisma.$transaction(async tx => {
    const cobro = await tx.user.updateMany({ where: { id: userId, monedas: { gte: p } }, data: { monedas: { decrement: p } } })
    if (cobro.count === 0) throw new EconomiaError(402, 'No te alcanzan las monedas.')
    await tx.userChest.create({ data: { id, userId, tipo: 'legendario', origen: 'compra', refId: id } })
    await tx.coinLedger.create({ data: { userId, motivo: 'compra', refId: `cofre:${id}`, delta: -p, fecha: todayPeriodo(), detalle: 'Cofre legendario' } })
  })
  return { id, tipo: 'legendario' as const }
}

// ─── Paquetes comprados en la tienda (App Store / Google Play) ─────────────────

export const productoDePaquete = (id: string) => `kiri_${id}`
export const paqueteDeProducto = (productId: string) => PAQUETES.find(p => productoDePaquete(p.id) === productId) ?? null

/** ¿Ya compró monedas alguna vez? (la primera compra trae el doble) */
async function yaComproMonedas(userId: string) {
  return (await prisma.coinLedger.count({ where: { userId, motivo: 'paquete' } })) > 0
}

/** Abona un paquete pagado. Idempotente por transacción: la tienda puede avisar dos veces. */
export async function acreditarPaquete(userId: string, productId: string, transaccionId: string) {
  const p = paqueteDeProducto(productId)
  if (!p) return { monedas: 0, motivo: 'producto desconocido' }
  const doble = !(await yaComproMonedas(userId))
  const monedas = p.monedas * (doble ? 2 : 1)
  const abonadas = await mover(userId, 'paquete', transaccionId, monedas, `Paquete ${p.monedas}${doble ? ' (primera compra x2)' : ''}`)
  return { monedas: abonadas ?? 0, doble }
}

/** Reembolso de un paquete: se descuentan las monedas que dio (sin bajar de 0). */
export async function revertirPaquete(userId: string, transaccionId: string) {
  const fila = await prisma.coinLedger.findUnique({ where: { userId_motivo_refId: { userId, motivo: 'paquete', refId: transaccionId } } })
  if (!fila) return 0
  return (await mover(userId, 'reverso', `paquete:${transaccionId}`, -fila.delta, 'Reembolso de la tienda')) ?? 0
}

// ─── Abrir un cofre: el servidor sortea el premio ────────────────────────────

const azar = () => randomInt(0, 1_000_000) / 1_000_000

export async function abrirCofre(userId: string, cofreId: string) {
  const cofre = await prisma.userChest.findFirst({ where: { id: cofreId, userId } })
  if (!cofre) throw new EconomiaError(404, 'Cofre no encontrado.')
  if (cofre.estado !== 'pendiente') throw new EconomiaError(409, 'Ese cofre ya se abrió.')
  const regla = COFRES[cofre.tipo as TipoCofre]
  if (!regla) throw new EconomiaError(400, 'Cofre inválido.')

  const { posee } = await inventario(userId)
  let monedas = randomInt(regla.monedas[0], regla.monedas[1] + 1)
  let articulo: { tipo: TipoCosmetico; clave: string } | null = null
  // Aspecto (especie o accesorio) que no tenga; el común nunca da aspectos
  if (regla.aspecto > 0 && azar() < regla.aspecto) {
    const pool = TIPOS_ASPECTO.flatMap(t => Object.keys(CATALOGO[t]).filter(k => !posee(t, k)).map(clave => ({ tipo: t, clave })))
    if (pool.length) articulo = pool[randomInt(0, pool.length)]
  }
  if (!articulo && regla.color > 0 && azar() < regla.color) {
    const pool = Object.keys(CATALOGO.color).filter(k => !posee('color', k)).map(clave => ({ tipo: 'color' as const, clave }))
    if (pool.length) articulo = pool[randomInt(0, pool.length)]
  }
  // Legendario sin nada nuevo que dar (ya lo tiene todo): monedas extra
  if (!articulo && regla.aspecto >= 1) monedas += regla.extraSiCompleto

  const premio = { monedas, articulo }
  await prisma.$transaction(async tx => {
    const marca = await tx.userChest.updateMany({ where: { id: cofreId, userId, estado: 'pendiente' }, data: { estado: 'abierto', abiertoAt: new Date(), premio } })
    if (marca.count === 0) throw new EconomiaError(409, 'Ese cofre ya se abrió.')
    if (articulo) await tx.userCosmetic.createMany({ data: [{ userId, tipo: articulo.tipo, clave: articulo.clave, origen: 'cofre' }], skipDuplicates: true })
    await mover(userId, 'cofre', cofreId, monedas, `Cofre ${cofre.tipo}`, tx)
  })
  return { tipo: cofre.tipo, ...premio }
}
