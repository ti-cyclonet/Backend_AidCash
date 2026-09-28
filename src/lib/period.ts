/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Periodos de obligaciones (deudas y gastos fijos)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Mismo patrón `periodo`-string sin cron que ya usan MissionProgress/GardenWatering/
 * ImpulseExpense: en vez de un booleano mutable que nadie resetea, cada pago se
 * etiqueta con el periodo al que pertenece, y "¿está pagado este periodo?" se
 * calcula sumando los pagos cuyo `periodo` coincide con el periodo actual.
 */

export type Frecuencia = 'mensual' | 'quincenal' | 'semanal' | 'anual'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Parsea un string de días de pago tipo "5,28" (o "5" o "2026-08-15") a
 * números válidos — mismo parseo que ya usa el cron y el frontend.
 */
export function parseDiasPago(value: string | null | undefined): number[] {
  if (!value) return []
  const raw = value.includes('-') ? value.split('-').pop() ?? value : value
  return raw.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d) && d >= 1 && d <= 31)
}

/** "2026-08" */
export function getPeriodoMensual(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
}

/**
 * Días de pago del usuario, ordenados y validados. `diasPago` puede venir vacío
 * (usuario nunca configuró sus días) o con un solo valor (mensual) — en esos
 * casos no hay frontera quincenal real que usar.
 */
function paydayBoundary(diasPago: number[]): [number, number] | null {
  const valid = diasPago.filter(d => Number.isInteger(d) && d >= 1 && d <= 31).sort((a, b) => a - b)
  return valid.length >= 2 ? [valid[0], valid[1]] : null
}

/**
 * "2026-08-Q1" | "2026-08-Q2" — frontera basada en los días de pago reales del
 * usuario (`diasPago`, ej. [10, 25]): Q1 = [d1, d2), Q2 = [d2, d1 del mes
 * siguiente). Si el usuario no tiene días configurados (`diasPago` vacío o con
 * un solo valor), cae al calendario fijo día ≤15 = Q1 — el comportamiento de
 * siempre, para no romper a nadie que no haya tocado `PaydaySelector`.
 *
 * Cuando `d1 > 1` (ej. [15, 30]), los primeros días del mes (1 al d1-1) siguen
 * siendo parte del periodo Q2 que arrancó el MES ANTERIOR — se etiquetan con
 * ese mes anterior, no con el mes actual, para no fusionar dos ciclos de pago
 * distintos bajo el mismo string de periodo.
 */
export function getPeriodoQuincenal(diasPago: number[] = [], now: Date = new Date()): string {
  const boundary = paydayBoundary(diasPago)
  const day = now.getDate()

  if (!boundary) {
    return `${getPeriodoMensual(now)}-${day <= 15 ? 'Q1' : 'Q2'}`
  }

  const [d1, d2] = boundary
  if (day >= d1 && day < d2) return `${getPeriodoMensual(now)}-Q1`
  if (day >= d2) return `${getPeriodoMensual(now)}-Q2`
  // day < d1: todavía dentro del periodo Q2 que arrancó el mes anterior.
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${getPeriodoMensual(prevMonth)}-Q2`
}

/** ISO week, mismo formato que MissionProgress: "2026-W35" */
export function getPeriodoSemanal(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${pad(weekNum)}`
}

/** "2026" */
export function getPeriodoAnual(now: Date = new Date()): string {
  return String(now.getFullYear())
}

export function getPeriodo(frecuencia: string, diasPago: number[] = [], now: Date = new Date()): string {
  switch (frecuencia) {
    case 'quincenal': return getPeriodoQuincenal(diasPago, now)
    case 'semanal': return getPeriodoSemanal(now)
    case 'anual': return getPeriodoAnual(now)
    default: return getPeriodoMensual(now)
  }
}

/**
 * Periodo INMEDIATAMENTE SIGUIENTE al de `now` — para una obligación recién
 * creada que el usuario marca como "nueva, empieza el próximo periodo" (ver
 * FixedExpense.activoDesdePeriodo). Avanza la fecha lo suficiente para caer
 * con certeza en el siguiente periodo de esa frecuencia y calcula el string
 * de periodo desde ahí, en vez de repetir a mano la lógica de cada caso.
 */
/**
 * Comparación de strings de periodo ("2026-10" > "2026-09", "2026-09-Q2" >
 * "2026-09-Q1") — mismo formato de ancho fijo en todos los casos de
 * getPeriodo, así que un simple ">" lexicográfico basta sin parsear cada
 * variante. Usado por deudas y gastos fijos para decidir si una obligación
 * marcada "nueva, empieza el próximo periodo" ya le llegó su periodo o no.
 */
export function esPendienteProximoPeriodo(activoDesdePeriodo: string | null | undefined, periodoActual: string): boolean {
  return !!activoDesdePeriodo && activoDesdePeriodo > periodoActual
}

/**
 * Primer periodo distinto de `periodoDe(now)` avanzando día a día. Sirve para
 * cualquier frontera (antes quincenal sumaba +16 días a ciegas, y con días de
 * cobro como [1, 20] — una "quincena" de 19 días — seguía cayendo en el mismo
 * periodo).
 */
export function periodoSiguienteDe(periodoDe: (d: Date) => string, now: Date = new Date()): string {
  const actual = periodoDe(now)
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (let i = 0; i < 400; i++) {
    d.setDate(d.getDate() + 1)
    const p = periodoDe(d)
    if (p !== actual) return p
  }
  return actual
}

/**
 * Periodos COMPLETOS ya cerrados entre `desde` y el periodo de `now`
 * (excluido), del más antiguo al más reciente — para detectar cuotas atrasadas.
 * Se recorre día a día con la misma función que etiqueta los pagos, así nunca
 * puede haber desacuerdo sobre qué periodo es cuál.
 */
export function periodosAnteriores(periodoDe: (d: Date) => string, desde: Date, now: Date = new Date()): string[] {
  const actual = periodoDe(now)
  const out: string[] = []
  const d = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate())
  const fin = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  while (d < fin) {
    const p = periodoDe(d)
    if (p !== actual && out[out.length - 1] !== p) out.push(p)
    d.setDate(d.getDate() + 1)
  }
  return out
}

export function getNextPeriodo(frecuencia: string, diasPago: number[] = [], now: Date = new Date()): string {
  switch (frecuencia) {
    case 'quincenal':
      return periodoSiguienteDe(d => getPeriodoQuincenal(diasPago, d), now)
    case 'semanal': {
      const advanced = new Date(now)
      advanced.setDate(advanced.getDate() + 7)
      return getPeriodoSemanal(advanced)
    }
    case 'anual':
      return getPeriodoAnual(new Date(now.getFullYear() + 1, now.getMonth(), 1))
    default:
      return getPeriodoMensual(new Date(now.getFullYear(), now.getMonth() + 1, 1))
  }
}

/** Cuántas semanas (lunes) empiezan dentro del mes de `now` — normalmente 4, a veces 5. */
export function semanasQueEmpiezanEsteMes(now: Date = new Date()): number {
  const year = now.getFullYear()
  const month = now.getMonth()
  const lastDay = new Date(year, month + 1, 0).getDate()
  let count = 0
  for (let day = 1; day <= lastDay; day++) {
    if (new Date(year, month, day).getDay() === 1) count++
  }
  return count || 4
}

/**
 * Monto que corresponde pagar en el periodo actual, dado el monto "de referencia"
 * de la obligación (mensual = monto tal cual; el resto se deriva de él).
 *   - mensual: se cobra completo, un periodo = un mes.
 *   - quincenal: la mitad, dos periodos por mes.
 *   - semanal: monto / semanas que arrancan este mes (4 casi siempre, a veces 5 —
 *     por eso una semana puede "pesar" distinto que otra dentro del mismo mes).
 *   - anual: se cobra completo, un periodo = un año.
 */
export function getMontoPorPeriodo(monto: number, frecuencia: string, now: Date = new Date()): number {
  switch (frecuencia) {
    case 'quincenal': return Math.round((monto / 2) * 100) / 100
    case 'semanal': return Math.round((monto / semanasQueEmpiezanEsteMes(now)) * 100) / 100
    case 'anual': return monto
    default: return monto
  }
}
