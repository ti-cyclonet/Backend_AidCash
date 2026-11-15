/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Plan semanal de gasto (Billetera)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Un consejo para llegar al próximo cobro sin endeudarse: de lo que queda
 * después de pagar las obligaciones del periodo (y de apartar el ahorro
 * sugerido) sale el "disponible para gastar", y se reparte por semanas:
 *   - quincenal → 2 semanas, mensual → 4, según los días reales del periodo
 *     de cobro (una quincena de 15 días queda en 8 + 7, y cada semana recibe
 *     plata según sus días).
 *
 * Cómo se mueve:
 *   - La meta de la semana en curso se CONGELA la primera vez que se calcula
 *     (así "lo que debías usar" no cambia después). Solo sube si entra plata
 *     nueva después de congelarla, o si se congeló cuando aún no había saldo.
 *   - Las semanas que faltan se recalculan siempre con lo que queda: si se
 *     pasa en una semana, las siguientes bajan; si entra un ingreso, suben.
 *   - Al terminar, cada semana se cierra con lo que de verdad se gastó
 *     (todos los gastos variables, también los hechos con tarjeta):
 *     lograda (+5 monedas, XP del árbol) o fallida. Se cierra al abrir la
 *     app o con el cron diario, lo que pase primero; nunca dos veces.
 *
 * Las obligaciones pendientes las manda el cliente (es el mismo número que ya
 * muestra Billetera, calculado en lib/obligaciones del frontend); el saldo, los
 * gastos, las metas y las monedas los decide el servidor.
 */
import { prisma } from '../config/database.js'
import { premiarSemanaLograda, sinFallar } from './economia.js'
import { avisar } from './push.js'

const DIA = 86_400_000

export type Frecuencia = 'quincenal' | 'mensual'
export type EstadoSemana = 'pasada_sin_plan' | 'lograda' | 'fallida' | 'sin_plan' | 'actual' | 'proxima'

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const sumarDias = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const diasEntre = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DIA)
const redondear = (n: number) => Math.round(n)

// ─── Periodo de cobro ─────────────────────────────────────────────────────────

/**
 * [inicio, fin) del periodo de cobro: del último día de pago (hoy incluido) al
 * siguiente. Misma regla que la tarjeta "Periodo" del dashboard: un día de pago
 * que no existe en el mes (30 en febrero) cae en el último día.
 */
export function rangoDeCobro(frecuencia: Frecuencia, diasPago: number[], now: Date = new Date()) {
  const dias = [...new Set(diasPago.filter(d => Number.isInteger(d) && d >= 1 && d <= 31))].sort((a, b) => a - b)
  const usados = frecuencia === 'quincenal' ? (dias.length >= 2 ? dias.slice(0, 2) : [1, 16]) : [dias[0] ?? 1]
  const y = now.getFullYear(), m = now.getMonth()
  const real = (mes: number, d: number) => new Date(y, mes, Math.min(d, new Date(y, mes + 1, 0).getDate()))
  const fechas = [-1, 0, 1, 2].flatMap(k => usados.map(d => real(m + k, d))).sort((a, b) => a.getTime() - b.getTime())
  const hoy = new Date(y, m, now.getDate())
  const inicio = [...fechas].reverse().find(f => f <= hoy) ?? fechas[0]
  const fin = fechas.find(f => f > hoy) ?? sumarDias(inicio, 30)
  return { inicio, fin }
}

/** Parte el periodo en N semanas de días enteros; las primeras se llevan el día que sobre. */
export function partirEnSemanas(inicio: Date, fin: Date, n: number) {
  const total = Math.max(n, diasEntre(inicio, fin))
  const base = Math.floor(total / n), extra = total % n
  const out: { indice: number; inicio: Date; fin: Date; dias: number }[] = []
  let cursor = inicio
  for (let i = 0; i < n; i++) {
    const dias = base + (i < extra ? 1 : 0)
    const finI = sumarDias(cursor, dias)
    out.push({ indice: i + 1, inicio: cursor, fin: finI, dias })
    cursor = finI
  }
  return out
}

// ─── Distribución (misma fórmula que Frontend lib/distribucion-billetera.ts) ──

/** Ahorro sugerido del periodo sobre un saldo: 5/10/15/20 % según lo que deje libre de obligaciones. */
function ahorroSugerido(saldo: number, obligaciones: number) {
  if (saldo <= 0 || obligaciones >= saldo) return 0
  const remanente = saldo - obligaciones
  const remanentePct = (remanente / saldo) * 100
  const pctAhorro = remanentePct >= 40 ? 20 : remanentePct >= 25 ? 15 : remanentePct >= 15 ? 10 : 5
  return Math.min((pctAhorro / 100) * saldo, remanente)
}

/**
 * Del saldo: primero obligaciones, luego el ahorro que FALTA del periodo; el
 * resto es para gastar. La meta de ahorro se calcula sobre el saldo de antes
 * de ahorrar (saldo + `yaAhorrado` en el periodo): si no, al ahorrar lo
 * sugerido el saldo baja y se volvía a sugerir un % del saldo nuevo, como si
 * no hubiera ahorrado nada.
 */
export function disponibleParaGastar(saldo: number, obligaciones: number, yaAhorrado = 0) {
  const remanente = Math.max(0, saldo - obligaciones)
  const ahorrado = Math.max(0, yaAhorrado)
  const metaAhorro = ahorroSugerido(saldo + ahorrado, obligaciones)
  if (saldo <= 0 || obligaciones >= saldo) return { remanente, ahorro: 0, metaAhorro, ahorrado, libre: 0, sobrecargado: obligaciones > 0 && obligaciones >= saldo }
  const ahorro = Math.min(Math.max(0, metaAhorro - ahorrado), remanente)
  return { remanente, ahorro, metaAhorro, ahorrado, libre: Math.max(0, remanente - ahorro), sobrecargado: false }
}

/**
 * Lo ahorrado (neto) en el rango que salió de la billetera: aportes a bolsillos,
 * fondo de emergencia y ahorro libre (SavingsHistory) menos retiros, más los
 * aportes propios a bolsillos compartidos (no los "ya ahorrado" previos).
 */
async function ahorradoEnRango(userId: string, inicio: Date, fin: Date) {
  const [historial, compartidos] = await Promise.all([
    prisma.savingsHistory.groupBy({ by: ['tipo'], where: { userId, createdAt: { gte: inicio, lt: fin }, tipo: { in: ['ahorro', 'retiro'] } }, _sum: { monto: true } }),
    prisma.sharedDeposit.aggregate({ where: { userId, createdAt: { gte: inicio, lt: fin }, monto: { gt: 0 }, nota: { startsWith: '[APORTE]' } }, _sum: { monto: true } }),
  ])
  const de = (tipo: string) => Number(historial.find(h => h.tipo === tipo)?._sum.monto ?? 0)
  return Math.max(0, de('ahorro') - de('retiro') + Number(compartidos._sum.monto ?? 0))
}

/** Semanas del plan que empiezan en [desde, hasta): para el Historial. */
export async function semanasEnRango(userId: string, desde: Date, hasta: Date) {
  await cerrarSemanasVencidas(new Date(), [userId])
  const filas = await prisma.semanaPlan.findMany({ where: { userId, inicio: { gte: desde, lt: hasta } }, orderBy: { inicio: 'asc' } })
  return filas.map(f => ({
    inicio: ymd(f.inicio), fin: ymd(sumarDias(f.fin, -1)), indice: f.indice,
    meta: redondear(Number(f.meta)), gastado: f.gastado != null ? redondear(Number(f.gastado)) : null,
    estado: f.estado, monedas: f.monedas, congelada: f.congelada,
  }))
}

/** Lo ahorrado en el periodo de cobro actual (para la distribución de Billetera). */
export async function ahorradoDelPeriodo(userId: string, frecuenciaIngreso: string | null, diasPago: number[] | null, now: Date = new Date()) {
  const { inicio, fin } = rangoDeCobro(frecuenciaIngreso === 'quincenal' ? 'quincenal' : 'mensual', diasPago ?? [], now)
  return ahorradoEnRango(userId, inicio, fin)
}

// ─── Cierre de semanas ────────────────────────────────────────────────────────

async function gastadoEnRango(userId: string, inicio: Date, fin: Date) {
  const r = await prisma.impulseExpense.aggregate({ where: { userId, createdAt: { gte: inicio, lt: fin } }, _sum: { monto: true } })
  return Number(r._sum.monto ?? 0)
}

/** Semanas logradas seguidas terminando en esta (cuenta entre periodos). */
async function rachaHasta(userId: string, fin: Date) {
  const filas = await prisma.semanaPlan.findMany({
    where: { userId, fin: { lte: fin }, estado: { in: ['lograda', 'fallida'] } },
    orderBy: { fin: 'desc' }, take: 52, select: { estado: true },
  })
  let n = 0
  for (const f of filas) { if (f.estado !== 'lograda') break; n++ }
  return n
}

const fmt = (n: number) => `$${redondear(n).toLocaleString('es-CO')}`

/**
 * Cierra una semana ya terminada. Idempotente: solo la primera llamada que la
 * pasa de "abierta" a cerrada abona las monedas y avisa.
 */
export async function cerrarSemana(fila: { id: string; userId: string; periodo: string; indice: number; inicio: Date; fin: Date; meta: unknown }, gastado?: number) {
  const meta = Number(fila.meta)
  const real = gastado ?? await gastadoEnRango(fila.userId, fila.inicio, fila.fin)
  const estado = meta <= 0 ? 'sin_plan' : real <= meta ? 'lograda' : 'fallida'
  const marca = await prisma.semanaPlan.updateMany({ where: { id: fila.id, estado: 'abierta' }, data: { estado, gastado: real, cerradaAt: new Date() } })
  if (marca.count === 0) return null
  if (estado === 'sin_plan') return { estado, monedas: 0 }

  let monedas = 0
  if (estado === 'lograda') {
    await sinFallar('semana lograda', async () => {
      const racha = await rachaHasta(fila.userId, fila.fin)
      monedas = await premiarSemanaLograda(fila.userId, `${fila.periodo}#${fila.indice}`, racha)
      if (monedas > 0) await prisma.semanaPlan.update({ where: { id: fila.id }, data: { monedas } })
    })
  }
  await sinFallar('aviso semana', () => avisar(fila.userId, estado === 'lograda'
    ? { title: `Semana ${fila.indice} lograda`, body: `Gastaste ${fmt(real)} de ${fmt(meta)}. Ganaste ${monedas} monedas y tu árbol creció.`, tag: 'plan-semanal', url: '/gestion?tab=billetera', tipo: 'plan-semanal' }
    : { title: `Semana ${fila.indice}: te pasaste`, body: `Gastaste ${fmt(real)} y la meta era ${fmt(meta)}. Ajustamos las próximas semanas para que llegues al cobro.`, tag: 'plan-semanal', url: '/gestion?tab=billetera', tipo: 'plan-semanal' }))
  return { estado, monedas }
}

/** Cron: cierra todas las semanas terminadas que siguen abiertas (o solo las de unos usuarios). */
export async function cerrarSemanasVencidas(now: Date = new Date(), soloUsuarios?: string[]) {
  const filas = await prisma.semanaPlan.findMany({
    where: { estado: 'abierta', fin: { lte: now }, ...(soloUsuarios ? { userId: { in: soloUsuarios } } : {}) },
    take: 5000,
  })
  let cerradas = 0
  for (const f of filas) if (await cerrarSemana(f)) cerradas++
  return cerradas
}

// ─── Para el árbol ────────────────────────────────────────────────────────────

/**
 * Lo que el Jardín necesita del plan, sin depender de las obligaciones:
 *  - ritmo de la semana en curso (con su meta congelada): bien | rapido | pasado
 *    → si va rápido o ya se pasó, salen nubes;
 *  - la última semana cerrada: lograda (fruto de la semana) o fallida (hojas secas
 *    hasta que logre la siguiente).
 */
export async function estadoPlanParaArbol(userId: string, now: Date = new Date()) {
  await cerrarSemanasVencidas(now, [userId])
  const [actual, ultima] = await Promise.all([
    prisma.semanaPlan.findFirst({ where: { userId, inicio: { lte: now }, fin: { gt: now }, congelada: true } }),
    prisma.semanaPlan.findFirst({ where: { userId, estado: { in: ['lograda', 'fallida'] } }, orderBy: { fin: 'desc' } }),
  ])
  let ritmo: 'bien' | 'rapido' | 'pasado' | null = null
  if (actual && Number(actual.meta) > 0) {
    const meta = Number(actual.meta)
    const gastado = await gastadoEnRango(userId, actual.inicio, now)
    const dias = Math.max(1, diasEntre(actual.inicio, actual.fin))
    const transcurridos = Math.min(dias, diasEntre(actual.inicio, new Date(now.getFullYear(), now.getMonth(), now.getDate())) + 1)
    ritmo = gastado > meta ? 'pasado' : gastado > meta * (transcurridos / dias) * 1.15 ? 'rapido' : 'bien'
  }
  return {
    ritmo,
    ultima: ultima ? { estado: ultima.estado as 'lograda' | 'fallida', indice: ultima.indice, monedas: ultima.monedas, fin: ymd(sumarDias(ultima.fin, -1)) } : null,
    racha: await rachaHasta(userId, now),
  }
}

// ─── Consejos ─────────────────────────────────────────────────────────────────

/** Cada consejo es un código + datos; el cliente arma el texto (y lo traduce). */
export type Consejo =
  | { tipo: 'sobrecargado'; faltante: number }
  | { tipo: 'pasado_semana'; exceso: number }
  | { tipo: 'ritmo_rapido'; hoy: number }
  | { tipo: 'ritmo_bien' }
  | { tipo: 'deuda_cara'; nombre: string; tasa: number }
  | { tipo: 'deuda_pequena'; nombre: string; saldo: number }
  | { tipo: 'hormiga'; monto: number }
  | { tipo: 'sobrante' }
  | { tipo: 'sin_saldo' }

async function armarConsejos(userId: string, ctx: {
  saldo: number; obligaciones: number; libre: number; sobrecargado: boolean
  meta: number; gastadoSemana: number; diaDeSemana: number; diasSemana: number; hoy: number; hormiga: number
}): Promise<Consejo[]> {
  const out: Consejo[] = []
  if (ctx.saldo <= 0) return [{ tipo: 'sin_saldo' }]
  if (ctx.sobrecargado) out.push({ tipo: 'sobrecargado', faltante: redondear(ctx.obligaciones - ctx.saldo) })

  if (ctx.meta > 0) {
    const esperado = ctx.meta * (ctx.diaDeSemana / ctx.diasSemana)
    if (ctx.gastadoSemana > ctx.meta) out.push({ tipo: 'pasado_semana', exceso: redondear(ctx.gastadoSemana - ctx.meta) })
    else if (ctx.gastadoSemana > esperado * 1.15 && ctx.gastadoSemana > 0) out.push({ tipo: 'ritmo_rapido', hoy: redondear(ctx.hoy) })
    else if (ctx.diaDeSemana >= 2) out.push({ tipo: 'ritmo_bien' })
  }

  // Deudas: primero la más cara (avalancha); si no hay tasas, la más pequeña (bola de nieve)
  const deudas = await prisma.debt.findMany({
    where: { userId, estado: 'activa', saldoRestante: { gt: 0 } },
    select: { nombre: true, saldoRestante: true, tasaInteresAplicada: true, tasaInteres: true },
  })
  if (deudas.length) {
    // Tasa MENSUAL en %: la observada en los pagos o la que escribió el usuario (igual que al pagar en debts.routes)
    const conTasa = deudas
      .map(d => ({ nombre: d.nombre, tasa: Number(d.tasaInteresAplicada ?? d.tasaInteres ?? 0) }))
      .filter(d => d.tasa > 0)
      .sort((a, b) => b.tasa - a.tasa)
    if (conTasa.length) out.push({ tipo: 'deuda_cara', nombre: conTasa[0].nombre, tasa: Math.round(conTasa[0].tasa * 100) / 100 })
    else {
      const menor = [...deudas].sort((a, b) => Number(a.saldoRestante) - Number(b.saldoRestante))[0]
      out.push({ tipo: 'deuda_pequena', nombre: menor.nombre, saldo: redondear(Number(menor.saldoRestante)) })
    }
  }

  if (ctx.libre > 0 && ctx.hormiga > ctx.libre * 0.1) out.push({ tipo: 'hormiga', monto: redondear(ctx.hormiga) })
  if (out.length < 3) out.push({ tipo: 'sobrante' })
  return out.slice(0, 3)
}

// ─── Plan del periodo ─────────────────────────────────────────────────────────

export interface SemanaVista {
  indice: number
  inicio: string
  fin: string // último día incluido
  dias: number
  meta: number
  gastado: number
  estado: EstadoSemana
  monedas: number
}

export async function planSemanal(userId: string, obligacionesCliente: number, now: Date = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { cashBalance: true, frecuenciaIngreso: true, diasPago: true } })
  if (!user) return null

  const frecuencia: Frecuencia = user.frecuenciaIngreso === 'quincenal' ? 'quincenal' : 'mensual'
  const { inicio, fin } = rangoDeCobro(frecuencia, user.diasPago ?? [], now)
  const periodo = ymd(inicio)
  const semanas = partirEnSemanas(inicio, fin, frecuencia === 'quincenal' ? 2 : 4)
  const k = Math.max(0, semanas.findIndex(s => now >= s.inicio && now < s.fin))
  const actual = semanas[k]

  const saldo = Number(user.cashBalance)
  const obligaciones = Math.max(0, Math.min(Number.isFinite(obligacionesCliente) ? obligacionesCliente : 0, 1e12))
  // Lo ya ahorrado en este periodo cuenta para la meta de ahorro (no se vuelve a pedir)
  const ahorrado = await ahorradoEnRango(userId, inicio, fin)
  const dist = disponibleParaGastar(saldo, obligaciones, ahorrado)

  const gastos = await prisma.impulseExpense.findMany({
    where: { userId, createdAt: { gte: inicio, lt: fin } },
    select: { monto: true, createdAt: true, tarjetaId: true, esHormiga: true },
  })
  const enSemana = (i: number, soloEfectivo = false) => gastos
    .filter(g => g.createdAt >= semanas[i].inicio && g.createdAt < semanas[i].fin && (!soloEfectivo || !g.tarjetaId))
    .reduce((s, g) => s + Number(g.monto), 0)
  const hormiga = gastos.filter(g => g.esHormiga).reduce((s, g) => s + Number(g.monto), 0)

  // 1. Semanas ya terminadas (de este periodo o de uno anterior): se cierran, una sola vez
  await cerrarSemanasVencidas(now, [userId])

  let filas = await prisma.semanaPlan.findMany({ where: { userId, periodo } })
  const fila = (indice: number) => filas.find(f => f.indice === indice)

  // 2. Meta de la semana en curso
  const gastadoActualEfectivo = enSemana(k, true)
  const diasRestantes = semanas.slice(k).reduce((s, x) => s + x.dias, 0)
  // Lo que había para gastar al empezar la semana: se reparte el saldo que había
  // antes de los gastos de esta semana (con las mismas reglas). Sumar el gasto a
  // lo libre de hoy no sirve: si las obligaciones se comen el saldo, la meta
  // saldría igual a lo ya gastado y la semana siempre quedaría "lograda".
  const libreAlEmpezar = disponibleParaGastar(saldo + gastadoActualEfectivo, obligaciones, ahorrado).libre
  const calculada = redondear(libreAlEmpezar * actual.dias / Math.max(1, diasRestantes))
  const fk = fila(actual.indice)
  let meta = fk?.congelada ? Number(fk.meta) : null
  let recongelar = meta === null || (meta === 0 && calculada > 0)
  if (!recongelar && fk?.congeladaAt && calculada > (meta ?? 0)) {
    const ingresos = await prisma.incomeRecord.count({ where: { userId, createdAt: { gt: fk.congeladaAt } } })
    recongelar = ingresos > 0
  }
  if (recongelar) {
    meta = Math.max(meta ?? 0, calculada)
    await prisma.semanaPlan.upsert({
      where: { userId_periodo_indice: { userId, periodo, indice: actual.indice } },
      create: { userId, periodo, indice: actual.indice, inicio: actual.inicio, fin: actual.fin, meta, congelada: true, congeladaAt: now },
      update: { meta, congelada: true, congeladaAt: now },
    })
  }
  const metaActual = meta ?? 0

  // 3. Semanas que faltan: lo libre menos lo que aún le queda a esta semana, repartido por días
  const futuras = semanas.slice(k + 1)
  const diasFuturos = futuras.reduce((s, x) => s + x.dias, 0)
  const bolsaFutura = Math.max(0, dist.libre - Math.max(0, metaActual - gastadoActualEfectivo))
  for (const s of futuras) {
    const metaS = diasFuturos > 0 ? redondear(bolsaFutura * s.dias / diasFuturos) : 0
    const f = fila(s.indice)
    if (f && Number(f.meta) === metaS) continue
    await prisma.semanaPlan.upsert({
      where: { userId_periodo_indice: { userId, periodo, indice: s.indice } },
      create: { userId, periodo, indice: s.indice, inicio: s.inicio, fin: s.fin, meta: metaS },
      update: { meta: metaS },
    })
  }

  filas = await prisma.semanaPlan.findMany({ where: { userId, periodo } })

  const vista: SemanaVista[] = semanas.map((s, i) => {
    const f = fila(s.indice)
    const gastado = redondear(i < k && f?.gastado != null ? Number(f.gastado) : enSemana(i))
    let estado: EstadoSemana
    if (i < k) estado = !f ? 'pasada_sin_plan' : (f.estado as EstadoSemana)
    else estado = i === k ? 'actual' : 'proxima'
    if (i < k && estado === ('abierta' as EstadoSemana)) estado = 'sin_plan'
    return {
      indice: s.indice, inicio: ymd(s.inicio), fin: ymd(sumarDias(s.fin, -1)), dias: s.dias,
      meta: redondear(f ? Number(f.meta) : 0), gastado, estado, monedas: f?.monedas ?? 0,
    }
  })

  const gastadoSemana = redondear(enSemana(k))
  const diaDeSemana = Math.min(actual.dias, diasEntre(actual.inicio, new Date(now.getFullYear(), now.getMonth(), now.getDate())) + 1)
  const diasQuedanSemana = actual.dias - diaDeSemana + 1
  const hoy = Math.max(0, metaActual - gastadoSemana) / Math.max(1, diasQuedanSemana)

  const consejos = await armarConsejos(userId, {
    saldo, obligaciones, libre: dist.libre, sobrecargado: dist.sobrecargado,
    meta: metaActual, gastadoSemana, diaDeSemana, diasSemana: actual.dias, hoy, hormiga,
  })

  return {
    frecuencia,
    periodo: { inicio: ymd(inicio), fin: ymd(sumarDias(fin, -1)), proximoCobro: ymd(fin), diasRestantes: diasEntre(new Date(now.getFullYear(), now.getMonth(), now.getDate()), fin) },
    saldo: redondear(saldo),
    obligaciones: redondear(obligaciones),
    remanente: redondear(dist.remanente),
    // Lo que FALTA ahorrar este periodo (0 si ya cumplió la meta) y lo ya ahorrado
    ahorro: redondear(dist.ahorro),
    ahorroHecho: redondear(dist.ahorrado),
    metaAhorro: redondear(dist.metaAhorro),
    disponible: redondear(dist.libre),
    semanaActual: actual.indice,
    hoyPuedes: redondear(hoy),
    diasQuedanSemana,
    racha: await rachaHasta(userId, now),
    semanas: vista,
    consejos,
  }
}
