import { getPeriodo, parseDiasPago } from './period.js'
import type { DebtPayment } from '@prisma/client'

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
