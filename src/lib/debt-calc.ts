import { getPeriodo, parseDiasPago, periodoSiguienteDe, periodosAnteriores } from './period.js'
import type { DebtPayment, Prisma } from '@prisma/client'

type DebtSchedule = { frecuenciaPago: string; diasPago: string }

/** Periodo inmediatamente siguiente de la deuda — destino de "Adelantar próxima cuota". */
export function debtPeriodoSiguiente(debt: DebtSchedule, now: Date = new Date()): string {
  return periodoSiguienteDe(d => debtPeriodo(debt, d), now)
}

/**
 * La tasa guardada es MENSUAL. Una deuda quincenal tiene dos periodos por mes,
 * así que cada quincena causa la mitad — antes se cobraba la tasa mensual
 * completa en cada quincena (el doble de interés real), y además no calzaba
 * con la proyección del formulario de registro, que sí usaba tasa/2.
 */
export function tasaDelPeriodo(tasaMensual: number | null, frecuenciaPago: string): number | null {
  if (!tasaMensual) return tasaMensual
  return frecuenciaPago === 'quincenal' ? tasaMensual / 2 : tasaMensual
}

type CuotaFields = { cuotaPeriodo: Prisma.Decimal | number; cuotaOverride?: Prisma.Decimal | number | null; cuotaOverridePeriodo?: string | null }

/** Cuota base exigida en `periodo`: el ajuste "solo este mes" si aplica a ese periodo, si no la cuota normal. */
export function cuotaBaseDelPeriodo(debt: CuotaFields, periodo: string): number {
  if (debt.cuotaOverride != null && debt.cuotaOverridePeriodo === periodo) return Number(debt.cuotaOverride)
  return Number(debt.cuotaPeriodo)
}

export interface Atraso {
  periodo: string
  cuota: number
  pagado: number
  falta: number
}

/** Hasta cuántos periodos atrás se buscan cuotas sin pagar. */
export const ATRASOS_MAX_DIAS = 186

/**
 * Periodos ya cerrados que se deben revisar por atrasos: desde el periodo en
 * que se creó la deuda (o desde `activoDesdePeriodo` si arrancaba después),
 * con un tope de ~6 meses hacia atrás.
 */
export function periodosRevisables(
  debt: DebtSchedule & { createdAt: Date; activoDesdePeriodo?: string | null },
  now: Date = new Date(),
): string[] {
  const tope = new Date(now.getTime() - ATRASOS_MAX_DIAS * 86_400_000)
  const desde = debt.createdAt > tope ? debt.createdAt : tope
  return periodosAnteriores(d => debtPeriodo(debt, d), desde, now)
    .filter(p => !debt.activoDesdePeriodo || p >= debt.activoDesdePeriodo)
}

/**
 * Cuotas de periodos YA CERRADOS que quedaron sin cubrir. Antes, al cambiar de
 * mes/quincena el estado volvía a $0 y la cuota no pagada desaparecía sin
 * rastro (solo quedaba en el saldo). Las tarjetas de crédito se excluyen: su
 * cuota "mínima" cambia con cada compra y el banco la recalcula, no es fija.
 */
export function calcularAtrasos(
  debt: DebtSchedule & CuotaFields & { createdAt: Date; activoDesdePeriodo?: string | null; tipoDeuda: string; estado: string },
  payments: { periodo: string; montoPagado: Prisma.Decimal | number }[],
  now: Date = new Date(),
): Atraso[] {
  if (debt.tipoDeuda === 'TARJETA_CREDITO' || debt.estado !== 'activa') return []
  const atrasos: Atraso[] = []
  for (const periodo of periodosRevisables(debt, now)) {
    const cuota = cuotaBaseDelPeriodo(debt, periodo)
    const pagado = payments.filter(p => p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
    const falta = Math.round((cuota - pagado) * 100) / 100
    if (falta > 0.009) atrasos.push({ periodo, cuota, pagado, falta })
  }
  return atrasos
}

// ─── Estado derivado por periodo ────────────────────────────────────────────────
// pagadoEstePeriodo/montoPagadoEstePeriodo ya no son columnas: se calculan sumando
// los DebtPayment cuyo `periodo` coincide con el periodo actual de la deuda. Así,
// al cruzar a un periodo nuevo (quincena/mes siguiente) el monto vuelve a $0 solo,
// sin necesitar un cron que resetee nada.
//
// La frontera Q1/Q2 de una deuda QUINCENAL usa sus PROPIOS `diasPago` (ej. "5,28"
// — las dos fechas reales en que se cobra ESA deuda), no los días de pago del
// sueldo del usuario: son dos ciclos distintos (cuándo te pagan a ti vs. cuándo
// te cobran a ti esta deuda en particular) que pueden no coincidir en absoluto.
export function debtPeriodo(debt: { frecuenciaPago: string; diasPago: string }, now: Date = new Date()): string {
  if (debt.frecuenciaPago !== 'quincenal') return getPeriodo('mensual', [], now)
  return getPeriodo('quincenal', parseDiasPago(debt.diasPago), now)
}

export interface DebtPeriodStatus {
  periodo: string
  montoPagadoEstePeriodo: number
  interesPagadoEstePeriodo: number
  /** Saldo justo antes del primer pago del periodo actual — base para calcular el interés del periodo completo */
  saldoAlIniciarPeriodo: number
}

export function computePeriodStatus(payments: DebtPayment[], periodo: string, saldoActualFallback: number): DebtPeriodStatus {
  const own = payments.filter(p => p.periodo === periodo).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const montoPagadoEstePeriodo = own.reduce((s, p) => s + Number(p.montoPagado), 0)
  const interesPagadoEstePeriodo = own.reduce((s, p) => s + Number(p.pagoInteres), 0)
  const saldoAlIniciarPeriodo = own.length > 0 ? Number(own[0].saldoAnterior) : saldoActualFallback
  return { periodo, montoPagadoEstePeriodo, interesPagadoEstePeriodo, saldoAlIniciarPeriodo }
}

/**
 * Resumen de los pagos del periodo actual de una obligación (deuda o gasto
 * fijo) — lo usa el frontend para decidir qué ofrecer al "Deshacer pago": si
 * hay más de un pago en el periodo (cuota + abonos), preguntar si deshacer
 * solo el último o todo; si hay uno solo, deshacerlo directo.
 */
export interface ResumenPagosPeriodo {
  cantidad: number
  ultimoMonto: number | null
  ultimoEsMarcador: boolean
}

export function resumenPagosPeriodo(
  payments: { periodo: string; montoPagado: unknown; createdAt: Date; esMarcador: boolean }[],
  periodo: string,
): ResumenPagosPeriodo {
  const own = payments.filter(p => p.periodo === periodo).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return {
    cantidad: own.length,
    ultimoMonto: own.length > 0 ? Number(own[0].montoPagado) : null,
    ultimoEsMarcador: own.length > 0 ? own[0].esMarcador : false,
  }
}

export interface PagoDeudaResult {
  pagoInteres: number
  abonoCapital: number
  nuevoSaldo: number
  nuevoEstado: 'activa' | 'saldada'
}

/**
 * Calcula cómo se divide un pago de deuda entre interés y abono a capital —
 * usada tanto por /pay como por /pay-with-card, para que pagar con tarjeta NO
 * se salte el interés real de la deuda que se está pagando (el costo financiero
 * de esa deuda no depende de cómo se pagó, solo de su saldo y tasa).
 */
export function calcularPagoDeuda(currentSaldo: number, tasaMensual: number | null, status: DebtPeriodStatus, montoPago: number): PagoDeudaResult {
  const interesTotalPeriodo = tasaMensual && tasaMensual > 0
    ? Math.round(status.saldoAlIniciarPeriodo * (tasaMensual / 100) * 100) / 100
    : 0
  const interesRestante = Math.max(0, Math.round((interesTotalPeriodo - status.interesPagadoEstePeriodo) * 100) / 100)
  // El interés de este pago nunca puede superar ni el efectivo pagado ni lo que falta del periodo.
  const pagoInteres = Math.min(montoPago, interesRestante)
  const abonoCapital = Math.round((montoPago - pagoInteres) * 100) / 100
  const nuevoSaldo = Math.max(0, Math.round((currentSaldo - abonoCapital) * 100) / 100)
  const nuevoEstado: 'activa' | 'saldada' = nuevoSaldo <= 0 ? 'saldada' : 'activa'
  return { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado }
}
