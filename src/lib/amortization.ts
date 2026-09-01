/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Motor de Amortización
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Calcula cómo se distribuye cada pago de una deuda entre:
 *   - Interés: lo que el banco cobra por el uso del dinero
 *   - Abono a capital: lo que realmente reduce tu deuda
 *
 * Fórmula (sistema francés / cuota fija):
 *   interés = saldoActual × tasaInteresMensual
 *   abonoCapital = cuotaPagada - interés
 *   nuevoSaldo = saldoActual - abonoCapital
 *
 * Si la cuota es menor que el interés generado, el saldo CRECE (amortización negativa).
 * Si no hay tasa de interés, todo el pago va a capital.
 */

export interface AmortizacionResult {
  /** Monto total pagado en esta cuota */
  montoPagado: number
  /** Porción que se fue a intereses (costo del préstamo) */
  pagoInteres: number
  /** Porción que realmente reduce la deuda */
  abonoCapital: number
  /** Saldo antes de este pago */
  saldoAnterior: number
  /** Saldo después de este pago */
  saldoPosterior: number
}

/**
 * Calcula la amortización de un pago de deuda.
 *
 * @param saldoActual - El saldo pendiente ANTES de este pago
 * @param tasaInteresMensual - La tasa de interés MENSUAL en porcentaje (ej: 1.85 = 1.85%)
 *                            Si es null/undefined/0, todo el pago va a capital.
 * @param cuota - El monto que el usuario está pagando en esta cuota
 * @returns Desglose de cómo se distribuyó el pago
 *
 * @example
 * // Deuda de $1,000,000 con tasa mensual 1.85%, pago de $50,000
 * calcularAmortizacion(1000000, 1.85, 50000)
 * // → { pagoInteres: 18500, abonoCapital: 31500, saldoPosterior: 968500, ... }
 */
export function calcularAmortizacion(
  saldoActual: number,
  tasaInteresMensual: number | null | undefined,
  cuota: number
): AmortizacionResult {
  const saldoAnterior = saldoActual

  // Si no hay tasa o es 0, todo el pago va directo a reducir el capital
  if (!tasaInteresMensual || tasaInteresMensual <= 0) {
    const abonoCapital = Math.min(cuota, saldoActual) // No puede abonar más de lo que debe
    return {
      montoPagado: cuota,
      pagoInteres: 0,
      abonoCapital,
      saldoAnterior,
      saldoPosterior: Math.max(0, saldoActual - abonoCapital),
    }
  }

  // Convertir porcentaje a decimal: 1.85% → 0.0185
  const tasaDecimal = tasaInteresMensual / 100

  // El interés se calcula sobre el saldo pendiente
  const interesGenerado = Math.round(saldoActual * tasaDecimal * 100) / 100

  // El interés registrado nunca puede superar lo efectivamente pagado — si la
  // cuota no alcanza a cubrir el interés generado, el interés "cobrado" es solo
  // la cuota completa (amortización negativa: el resto del interés generado que
  // no se pagó se suma al saldo, en vez de inflar el ledger con más interés del
  // que realmente entró en efectivo).
  const pagoInteres = Math.min(cuota, interesGenerado)
  const interesNoPagado = Math.round((interesGenerado - pagoInteres) * 100) / 100

  // Lo que queda después de pagar intereses va al capital
  const abonoCapital = Math.max(0, Math.round((cuota - pagoInteres) * 100) / 100)

  // Nuevo saldo = anterior - lo que se abonó a capital + el interés generado que no se pagó
  const saldoPosterior = Math.max(0, Math.round((saldoActual - abonoCapital + interesNoPagado) * 100) / 100)

  return {
    montoPagado: cuota,
    pagoInteres,
    abonoCapital,
    saldoAnterior,
    saldoPosterior,
  }
}

/**
 * Genera la tabla de amortización completa de una deuda.
 * Útil para visualizar cuántos meses faltan y cuánto se paga en total.
 */
export function generarTablaAmortizacion(
  saldoInicial: number,
  tasaInteresMensual: number,
  cuotaMensual: number,
  maxPeriodos: number = 360 // Máximo 30 años
): AmortizacionResult[] {
  const tabla: AmortizacionResult[] = []
  let saldo = saldoInicial

  for (let i = 0; i < maxPeriodos && saldo > 0; i++) {
    const cuota = Math.min(cuotaMensual, saldo + (saldo * (tasaInteresMensual / 100)))
    const resultado = calcularAmortizacion(saldo, tasaInteresMensual, cuota)
    tabla.push(resultado)
    saldo = resultado.saldoPosterior
    if (saldo <= 0) break
  }

  return tabla
}
