/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Resumen de presupuesto por categoría (fuente única)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Antes "cuánto gasté en X" se calculaba en el navegador en TRES sitios con
 * reglas distintas (gráfico de Presupuesto, "Consejo Kiri" y Balance), así que
 * cada pantalla podía mostrar un número diferente para la misma categoría. Esto
 * lo calcula una sola vez, en el servidor, con los datos reales:
 *   - gastos variables con esa categoría (FK),
 *   - pagos de gastos fijos cuya categoría es esa,
 *   - pagos de deudas cuya categoría es esa,
 * dentro del rango pedido (periodo de ingreso actual o mes calendario), sin los
 * pagos "marcador" (ya pagados por fuera de Kiri, no son gasto real).
 */
import { prisma } from '../config/database.js'
import { getPeriodo } from './period.js'
import { nombreBaseGasto } from './hormiga.js'

export type Alcance = 'periodo' | 'mes'

export interface Rango {
  inicio: Date
  fin: Date // exclusivo
  diasTotales: number
  diasTranscurridos: number
}

const DIA = 86_400_000

function inicioDelDia(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Rango [inicio, fin) del periodo que contiene `now`, recorriendo días con la misma función que etiqueta los gastos. */
export function rangoDePeriodo(periodoDe: (d: Date) => string, now: Date = new Date()): Rango {
  const actual = periodoDe(now)
  const inicio = inicioDelDia(now)
  while (periodoDe(new Date(inicio.getTime() - DIA)) === actual) inicio.setDate(inicio.getDate() - 1)
  const fin = inicioDelDia(now)
  while (periodoDe(fin) === actual) fin.setDate(fin.getDate() + 1)
  const diasTotales = Math.round((fin.getTime() - inicio.getTime()) / DIA)
  const diasTranscurridos = Math.min(diasTotales, Math.floor((inicioDelDia(now).getTime() - inicio.getTime()) / DIA) + 1)
  return { inicio, fin, diasTotales, diasTranscurridos }
}

/**
 * Cada categoría dice si su límite es del MES o de la QUINCENA (el usuario lo
 * elige al crearla). Antes el límite siempre era mensual y, si el usuario
 * cobraba quincenal, se partía a la mitad: un mercado del mes entero hecho en
 * una quincena salía "excedido". Ahora el límite se usa tal cual y lo que
 * cambia es el rango en el que se suma el gasto:
 *   - mensual: el mes de pago del usuario (sus dos quincenas juntas, o su mes);
 *   - quincenal: la quincena actual (la de sus días de cobro; si cobra mensual,
 *     1–15 y 16–fin de mes).
 */
export type FrecuenciaLimite = 'mensual' | 'quincenal'
export const esFrecuenciaLimite = (v: unknown): v is FrecuenciaLimite => v === 'mensual' || v === 'quincenal'

interface PeriodosUsuario {
  frecuencia: string
  /** Periodo de ingreso del usuario (lo que la app llama "este periodo") */
  usuario: (d: Date) => string
  mes: (d: Date) => string
  quincena: (d: Date) => string
}

async function periodosUsuario(userId: string): Promise<PeriodosUsuario> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { frecuenciaIngreso: true, diasPago: true } })
  const frecuencia = user?.frecuenciaIngreso ?? 'mensual'
  const diasPago = user?.diasPago ?? []
  const usuario = (d: Date) => getPeriodo(frecuencia, diasPago, d)
  return {
    frecuencia,
    usuario,
    // "2026-10-Q1" y "2026-10-Q2" son el mismo mes de pago
    mes: frecuencia === 'quincenal' ? (d: Date) => usuario(d).slice(0, 7) : (d: Date) => getPeriodo('mensual', [], d),
    quincena: frecuencia === 'quincenal' ? usuario : (d: Date) => getPeriodo('quincenal', [], d),
  }
}

/** Rango donde se suma el gasto de una categoría según cómo maneja su límite. */
function rangoCategoria(p: PeriodosUsuario, frecuenciaLimite: string, alcance: Alcance, now: Date): Rango {
  if (alcance === 'mes') return rangoDePeriodo(d => getPeriodo('mensual', [], d), now)
  return rangoDePeriodo(frecuenciaLimite === 'quincenal' ? p.quincena : p.mes, now)
}

/** Límite comparable con ese rango: en la vista de mes calendario una categoría quincenal cuenta dos quincenas. */
function limiteCategoria(montoLimite: number, frecuenciaLimite: string, alcance: Alcance): number {
  return alcance === 'mes' && frecuenciaLimite === 'quincenal' ? montoLimite * 2 : montoLimite
}

export async function rangoUsuario(userId: string, alcance: Alcance, now: Date = new Date()): Promise<{ rango: Rango; frecuencia: string }> {
  const p = await periodosUsuario(userId)
  const periodoDe = alcance === 'mes' ? (d: Date) => getPeriodo('mensual', [], d) : p.usuario
  return { rango: rangoDePeriodo(periodoDe, now), frecuencia: p.frecuencia }
}

export interface Movimiento {
  id: string
  nombre: string
  monto: number
  fecha: Date
  tipo: 'variable' | 'fijo' | 'deuda'
  esHormiga?: boolean
}

async function movimientosEnRango(userId: string, inicio: Date, fin: Date) {
  const [gastos, fijos, deudas] = await Promise.all([
    prisma.impulseExpense.findMany({
      where: { userId, createdAt: { gte: inicio, lt: fin } },
      select: { id: true, nombre: true, monto: true, createdAt: true, budgetCategoryId: true, esHormiga: true },
    }),
    prisma.fixedExpensePayment.findMany({
      where: { fixedExpense: { userId }, esMarcador: false, createdAt: { gte: inicio, lt: fin } },
      select: { id: true, montoPagado: true, createdAt: true, fixedExpense: { select: { nombre: true, budgetCategoryId: true } } },
    }),
    prisma.debtPayment.findMany({
      where: { debt: { userId }, esMarcador: false, createdAt: { gte: inicio, lt: fin } },
      select: { id: true, montoPagado: true, createdAt: true, debt: { select: { nombre: true, budgetCategoryId: true } } },
    }),
  ])
  const porCategoria = new Map<string | null, Movimiento[]>()
  const push = (cat: string | null, m: Movimiento) => porCategoria.set(cat, [...(porCategoria.get(cat) ?? []), m])
  for (const g of gastos) push(g.budgetCategoryId, { id: g.id, nombre: nombreBaseGasto(g.nombre) || g.nombre, monto: Number(g.monto), fecha: g.createdAt, tipo: 'variable', esHormiga: g.esHormiga })
  // Los pagos de fijos/deudas sin categoría NO van a "Sin categoría": esa
  // bolsa es para gastos del día a día que falta clasificar, no para cuotas.
  for (const f of fijos) if (f.fixedExpense.budgetCategoryId) push(f.fixedExpense.budgetCategoryId, { id: f.id, nombre: f.fixedExpense.nombre, monto: Number(f.montoPagado), fecha: f.createdAt, tipo: 'fijo' })
  for (const d of deudas) if (d.debt.budgetCategoryId) push(d.debt.budgetCategoryId, { id: d.id, nombre: d.debt.nombre, monto: Number(d.montoPagado), fecha: d.createdAt, tipo: 'deuda' })
  return porCategoria
}

function agruparItems(movs: Movimiento[], max = 8) {
  const grupos = new Map<string, { nombre: string; monto: number; cantidad: number; tipo: Movimiento['tipo'] }>()
  for (const m of movs) {
    const key = `${m.tipo}:${m.nombre.toLowerCase()}`
    const g = grupos.get(key) ?? { nombre: m.nombre, monto: 0, cantidad: 0, tipo: m.tipo }
    g.monto = Math.round((g.monto + m.monto) * 100) / 100
    g.cantidad++
    grupos.set(key, g)
  }
  return [...grupos.values()].sort((a, b) => b.monto - a.monto).slice(0, max)
}

const suma = (movs: Movimiento[]) => Math.round(movs.reduce((s, m) => s + m.monto, 0) * 100) / 100

export async function resumenCategorias(userId: string, alcance: Alcance = 'periodo', now: Date = new Date()) {
  const p = await periodosUsuario(userId)
  const frecuencia = p.frecuencia
  // Rango del periodo del usuario: para "Sin categoría" y para la cabecera
  const rango = rangoDePeriodo(alcance === 'mes' ? (d: Date) => getPeriodo('mensual', [], d) : p.usuario, now)

  // Cada categoría suma en su propio rango (mes o quincena); los movimientos de
  // un mismo rango se consultan una sola vez.
  const cache = new Map<string, ReturnType<typeof movimientosEnRango>>()
  const movsDe = (r: Rango) => {
    const k = `${r.inicio.getTime()}:${r.fin.getTime()}`
    if (!cache.has(k)) cache.set(k, movimientosEnRango(userId, r.inicio, r.fin))
    return cache.get(k)!
  }

  const [categorias, actualUsuario] = await Promise.all([
    prisma.budgetCategory.findMany({ where: { userId }, orderBy: { nombre: 'asc' } }),
    movsDe(rango),
  ])

  const categoriasOut = await Promise.all(categorias.map(async c => {
    const r = rangoCategoria(p, c.frecuenciaLimite, alcance, now)
    // Periodo anterior del mismo tipo (el que termina justo donde empieza este)
    const rAnt = rangoCategoria(p, c.frecuenciaLimite, alcance, new Date(r.inicio.getTime() - DIA))
    const [actual, anterior] = await Promise.all([movsDe(r), movsDe(rAnt)])
    const movs = actual.get(c.id) ?? []
    const gastado = suma(movs)
    const limiteConfigurado = Number(c.montoLimite)
    const limite = limiteCategoria(limiteConfigurado, c.frecuenciaLimite, alcance)
    const porcentaje = limite > 0 ? Math.round((gastado / limite) * 100) : 0
    // Proyección lineal al cierre del rango según el ritmo de gasto actual.
    const proyeccion = now < r.fin && r.diasTranscurridos > 0
      ? Math.round(gastado / r.diasTranscurridos * r.diasTotales)
      : gastado
    const gastadoAnterior = suma(anterior.get(c.id) ?? [])
    const estado: 'sin_limite' | 'ok' | 'alerta' | 'excedido' =
      limite <= 0 ? 'sin_limite' : gastado > limite ? 'excedido' : (porcentaje >= 80 || proyeccion > limite) ? 'alerta' : 'ok'
    return {
      id: c.id,
      nombre: c.nombre,
      icono: c.icono,
      color: c.color,
      frecuenciaLimite: esFrecuenciaLimite(c.frecuenciaLimite) ? c.frecuenciaLimite : 'mensual' as FrecuenciaLimite,
      periodo: { inicio: r.inicio, fin: r.fin },
      limiteConfigurado,
      limite,
      gastado,
      disponible: Math.max(0, Math.round((limite - gastado) * 100) / 100),
      porcentaje,
      proyeccion,
      estado,
      gastadoAnterior,
      variacionPct: gastadoAnterior > 0 ? Math.round(((gastado - gastadoAnterior) / gastadoAnterior) * 100) : null,
      cantidad: movs.length,
      items: agruparItems(movs),
      movimientos: movs.map(m => ({ monto: m.monto, fecha: m.fecha })),
    }
  }))

  const sinCat = actualUsuario.get(null) ?? []
  const totalLimite = categoriasOut.reduce((s, c) => s + c.limite, 0)
  const totalGastado = Math.round(categoriasOut.reduce((s, c) => s + c.gastado, 0) * 100) / 100

  return {
    alcance,
    frecuencia,
    rango: { inicio: rango.inicio, fin: rango.fin, diasTotales: rango.diasTotales, diasTranscurridos: rango.diasTranscurridos },
    categorias: categoriasOut,
    sinCategoria: {
      gastado: suma(sinCat),
      cantidad: sinCat.length,
      gastos: sinCat
        .sort((a, b) => b.fecha.getTime() - a.fecha.getTime())
        .map(m => ({ id: m.id, nombre: m.nombre, monto: m.monto, fecha: m.fecha, esHormiga: !!m.esHormiga })),
    },
    totales: {
      limite: Math.round(totalLimite * 100) / 100,
      gastado: totalGastado,
      gastadoConSinCategoria: Math.round((totalGastado + suma(sinCat)) * 100) / 100,
      gastadoAnterior: Math.round(categoriasOut.reduce((s, c) => s + c.gastadoAnterior, 0) * 100) / 100,
    },
  }
}

/**
 * Tras registrar un gasto en una categoría: ¿cruzó el 80% o el 100% de su
 * límite del periodo con ESTE gasto? Solo avisa al cruzar el umbral (no en
 * cada gasto posterior), así no se vuelve ruido.
 */
export async function alertaTrasGasto(userId: string, categoryId: string, montoNuevo: number) {
  const cat = await prisma.budgetCategory.findFirst({ where: { id: categoryId, userId } })
  if (!cat || Number(cat.montoLimite) <= 0) return null
  const p = await periodosUsuario(userId)
  const rango = rangoCategoria(p, cat.frecuenciaLimite, 'periodo', new Date())
  const movs = (await movimientosEnRango(userId, rango.inicio, rango.fin)).get(categoryId) ?? []
  const gastado = suma(movs)
  const limite = Number(cat.montoLimite)
  if (limite <= 0) return null
  const antes = (gastado - montoNuevo) / limite
  const ahora = gastado / limite
  const nivel = antes < 1 && ahora >= 1 ? 'excedido' : antes < 0.8 && ahora >= 0.8 ? 'alerta' : null
  if (!nivel) return null
  return { nivel, categoria: cat.nombre, categoryId, gastado, limite, porcentaje: Math.round(ahora * 100), frecuenciaLimite: cat.frecuenciaLimite }
}
