import { prisma } from '../config/database.js'
import { planPocketDeduction } from './wallet.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago, periodoSiguienteDe, periodosAnteriores } from './period.js'
import { ATRASOS_MAX_DIAS, type Atraso } from './debt-calc.js'
import { recordMissionAction } from './missions.js'

// La frontera Q1/Q2 de un gasto fijo QUINCENAL usa su PROPIA `fechaCorte` (ej.
// "5,28" — las dos fechas reales de cobro de ESE gasto), no los días de pago
// del sueldo del usuario — ver misma nota en debt-calc.ts.
export function fixedPeriodo(fe: { frecuencia: string; fechaCorte: string }, now: Date = new Date()): string {
  if (fe.frecuencia !== 'quincenal') return getPeriodo(fe.frecuencia, [], now)
  return getPeriodo('quincenal', parseDiasPago(fe.fechaCorte), now)
}

/** Periodo siguiente del gasto fijo — destino de "Adelantar próxima cuota". */
export function fixedPeriodoSiguiente(fe: { frecuencia: string; fechaCorte: string }, now: Date = new Date()): string {
  return periodoSiguienteDe(d => fixedPeriodo(fe, d), now)
}

/** Máximo de cuotas atrasadas que se muestran (un gasto semanal olvidado 6 meses serían 26). */
export const ATRASOS_FIJO_MAX = 6

type FixedParaAtrasos = { frecuencia: string; fechaCorte: string; monto: unknown; createdAt: Date; activoDesdePeriodo?: string | null }

/** Periodos ya cerrados que se revisan por atrasos (mismo criterio que deudas, ver periodosRevisables). */
export function fixedPeriodosRevisables(fe: FixedParaAtrasos, now: Date = new Date()): string[] {
  const tope = new Date(now.getTime() - ATRASOS_MAX_DIAS * 86_400_000)
  const desde = fe.createdAt > tope ? fe.createdAt : tope
  return periodosAnteriores(d => fixedPeriodo(fe, d), desde, now)
    .filter(p => !fe.activoDesdePeriodo || p >= fe.activoDesdePeriodo)
    .slice(-ATRASOS_FIJO_MAX)
}

/**
 * Cuotas de gasto fijo de periodos YA CERRADOS que quedaron sin cubrir —
 * igual que en deudas: antes, al cambiar de mes el gasto volvía a "pendiente"
 * y el mes que no se pagó desaparecía sin rastro.
 */
export function calcularAtrasosFijo(
  fe: FixedParaAtrasos,
  payments: { periodo: string; montoPagado: unknown }[],
  now: Date = new Date(),
): Atraso[] {
  const cuota = getMontoPorPeriodo(Number(fe.monto), fe.frecuencia, now)
  const atrasos: Atraso[] = []
  for (const periodo of fixedPeriodosRevisables(fe, now)) {
    const pagado = payments.filter(p => p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
    const falta = Math.round((cuota - pagado) * 100) / 100
    if (falta > 0.009) atrasos.push({ periodo, cuota, pagado, falta })
  }
  return atrasos
}

export class PeriodoFijoInvalidoError extends Error {}

export interface PayFixedExpenseResult {
  fixedExpense: Record<string, unknown>
  pagoConTarjeta: boolean
  tarjetaNombre?: string
  nuevoSaldoTarjeta?: number
}

/**
 * Registra el pago de la cuota de un gasto fijo — misma lógica exacta que usa
 * PATCH /fixed-expenses/:id/pay, extraída para que el cron de pago automático
 * (ver lib/auto-pay.ts) pueda ejecutarlo sin pasar por HTTP. Devuelve `null`
 * si el gasto no existe — quien llama decide qué hacer (404 en la ruta HTTP,
 * skip silencioso en el cron).
 */
/** destino: 'actual' (default) | 'siguiente' (adelantar) | periodo de una cuota atrasada, ej. "2026-08". */
export async function payFixedExpenseServer(userId: string, id: string, montoInput?: number, destino: string = 'actual', cuotaCompleta = false): Promise<PayFixedExpenseResult | null> {
  const existing = await prisma.fixedExpense.findFirst({ where: { id, userId }, include: { tarjetaVinculada: true } })
  if (!existing) return null

  let periodo: string
  if (destino === 'actual') periodo = fixedPeriodo(existing)
  else if (destino === 'siguiente') periodo = fixedPeriodoSiguiente(existing)
  else {
    if (!fixedPeriodosRevisables(existing).includes(destino)) throw new PeriodoFijoInvalidoError('Periodo no válido para este gasto')
    const pagosPrevios = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo: destino } })
    if (calcularAtrasosFijo(existing, pagosPrevios).length === 0) throw new PeriodoFijoInvalidoError('Esa cuota no está atrasada')
    periodo = destino
  }
  const montoPorPeriodo = getMontoPorPeriodo(Number(existing.monto), existing.frecuencia)
  // Sin monto, una cuota atrasada con abono parcial se completa por lo que falta.
  const pagadoAntes = destino !== 'actual' && destino !== 'siguiente'
    ? (await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })).reduce((s, p) => s + Number(p.montoPagado), 0)
    : 0
  const montoPago = montoInput ?? Math.max(0.01, Math.round((montoPorPeriodo - pagadoAntes) * 100) / 100)
  const prevPayments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
  const prevPaid = prevPayments.reduce((s, p) => s + Number(p.montoPagado), 0)
  const totalPaid = prevPaid + montoPago
  // "Con este valor quedó pagada la cuota" (ej. el recibo llegó más bajo): la
  // diferencia se cubre con un marcador — no mueve billetera ni tarjeta, no es
  // gasto, y deja el periodo pagado sin saldo pendiente.
  const faltaCuota = Math.round((montoPorPeriodo - totalPaid) * 100) / 100
  const ajusteOps = cuotaCompleta && faltaCuota > 0
    ? [prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: faltaCuota, periodo, esMarcador: true, createdAt: new Date(Date.now() - 1) } })]
    : []
  const isFullyPaid = totalPaid >= montoPorPeriodo || ajusteOps.length > 0

  if (existing.tarjetaVinculadaId && existing.tarjetaVinculada) {
    await prisma.$transaction([
      ...ajusteOps,
      prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo, tarjetaId: existing.tarjetaVinculadaId } }),
      prisma.debt.update({
        where: { id: existing.tarjetaVinculadaId },
        data: { saldoRestante: { increment: montoPago }, saldoPrincipal: { increment: montoPago } },
      }),
    ])

    await recordMissionAction(userId, 'pagar_obligacion')

    return {
      fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid, pagosPeriodo: { cantidad: prevPayments.length + 1, ultimoMonto: montoPago, ultimoEsMarcador: false } },
      pagoConTarjeta: true,
      tarjetaNombre: existing.tarjetaVinculada.nombre,
      nuevoSaldoTarjeta: Number(existing.tarjetaVinculada.saldoRestante) + montoPago,
    }
  }

  const walletDeductionData = planPocketDeduction('obligaciones', montoPago)
  await prisma.$transaction([
    ...ajusteOps,
    prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo } }),
    prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
  ])

  await recordMissionAction(userId, 'pagar_obligacion')

  return {
    fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid, pagosPeriodo: { cantidad: prevPayments.length + 1, ultimoMonto: montoPago, ultimoEsMarcador: false } },
    pagoConTarjeta: false,
  }
}
