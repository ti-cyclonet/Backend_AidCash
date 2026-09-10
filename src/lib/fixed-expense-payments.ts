import { prisma } from '../config/database.js'
import { planPocketDeduction } from './wallet.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from './period.js'
import { recordMissionAction } from './missions.js'

// La frontera Q1/Q2 de un gasto fijo QUINCENAL usa su PROPIA `fechaCorte` (ej.
// "5,28" — las dos fechas reales de cobro de ESE gasto), no los días de pago
// del sueldo del usuario — ver misma nota en debt-calc.ts.
export function fixedPeriodo(fe: { frecuencia: string; fechaCorte: string }, now: Date = new Date()): string {
  if (fe.frecuencia !== 'quincenal') return getPeriodo(fe.frecuencia, [], now)
  return getPeriodo('quincenal', parseDiasPago(fe.fechaCorte), now)
}

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
export async function payFixedExpenseServer(userId: string, id: string, montoInput?: number): Promise<PayFixedExpenseResult | null> {
  const existing = await prisma.fixedExpense.findFirst({ where: { id, userId }, include: { tarjetaVinculada: true } })
  if (!existing) return null

  const periodo = fixedPeriodo(existing)
  const montoPorPeriodo = getMontoPorPeriodo(Number(existing.monto), existing.frecuencia)
  const montoPago = montoInput ?? montoPorPeriodo
  const prevPayments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
  const prevPaid = prevPayments.reduce((s, p) => s + Number(p.montoPagado), 0)
  const totalPaid = prevPaid + montoPago
  const isFullyPaid = totalPaid >= montoPorPeriodo

  if (existing.tarjetaVinculadaId && existing.tarjetaVinculada) {
    await prisma.$transaction([
      prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo, tarjetaId: existing.tarjetaVinculadaId } }),
      prisma.debt.update({
        where: { id: existing.tarjetaVinculadaId },
        data: { saldoRestante: { increment: montoPago }, saldoPrincipal: { increment: montoPago } },
      }),
    ])

    await recordMissionAction(userId, 'pagar_obligacion')

    return {
      fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
      pagoConTarjeta: true,
      tarjetaNombre: existing.tarjetaVinculada.nombre,
      nuevoSaldoTarjeta: Number(existing.tarjetaVinculada.saldoRestante) + montoPago,
    }
  }

  const walletDeductionData = planPocketDeduction('obligaciones', montoPago)
  await prisma.$transaction([
    prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: montoPago, periodo } }),
    prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
  ])

  await recordMissionAction(userId, 'pagar_obligacion')

  return {
    fixedExpense: { ...existing, pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
    pagoConTarjeta: false,
  }
}
