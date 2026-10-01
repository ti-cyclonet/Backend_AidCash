import { prisma } from '../config/database.js'
import { esPendienteProximoPeriodo } from './period.js'
import {
  debtPeriodo, debtPeriodoSiguiente, computePeriodStatus, resumenPagosPeriodo,
  cuotaBaseDelPeriodo, calcularAtrasos, periodosRevisables,
} from './debt-calc.js'
import { cuotaEfectivaTarjeta } from './installments.js'
import type { Debt, DebtCardInstallment, DebtPayment } from '@prisma/client'

/**
 * Forma única en que el frontend recibe una deuda — antes GET, PATCH y
 * undo-pay armaban la respuesta cada uno a mano y divergían (ej. PATCH
 * devolvía la cuota base de una tarjeta en vez de la efectiva).
 */

/** Periodos de pago que hacen falta para mostrar una deuda: el actual, el siguiente y los cerrados revisables. */
function periodosNecesarios(d: Debt): string[] {
  return [debtPeriodo(d), debtPeriodoSiguiente(d), ...periodosRevisables(d)]
}

/** Trae en 2 queries todo lo que `serializarDeuda` necesita para un lote de deudas. */
export async function cargarContextoDeudas(debts: Debt[]) {
  const periodos = [...new Set(debts.flatMap(periodosNecesarios))]
  const [payments, installments] = await Promise.all([
    debts.length > 0
      ? prisma.debtPayment.findMany({ where: { debtId: { in: debts.map(d => d.id) }, periodo: { in: periodos } } })
      : Promise.resolve([] as DebtPayment[]),
    debts.some(d => d.tipoDeuda === 'TARJETA_CREDITO')
      ? prisma.debtCardInstallment.findMany({ where: { tarjetaId: { in: debts.filter(d => d.tipoDeuda === 'TARJETA_CREDITO').map(d => d.id) } } })
      : Promise.resolve([] as DebtCardInstallment[]),
  ])
  const paymentsByDebt = new Map<string, DebtPayment[]>()
  for (const p of payments) paymentsByDebt.set(p.debtId, [...(paymentsByDebt.get(p.debtId) ?? []), p])
  const installmentsByTarjeta = new Map<string, DebtCardInstallment[]>()
  for (const i of installments) installmentsByTarjeta.set(i.tarjetaId, [...(installmentsByTarjeta.get(i.tarjetaId) ?? []), i])
  return { paymentsByDebt, installmentsByTarjeta }
}

export function serializarDeuda(
  d: Debt,
  ctx: Awaited<ReturnType<typeof cargarContextoDeudas>>,
  extra: Record<string, unknown> = {},
) {
  const payments = ctx.paymentsByDebt.get(d.id) ?? []
  const installments = ctx.installmentsByTarjeta.get(d.id) ?? []
  const periodo = debtPeriodo(d)
  const periodoSiguiente = debtPeriodoSiguiente(d)

  const cuotaDe = (p: string) => {
    const base = cuotaBaseDelPeriodo(d, p)
    return d.tipoDeuda === 'TARJETA_CREDITO' ? cuotaEfectivaTarjeta(base, installments, { tarjeta: d, periodo: p }) : base
  }
  const cuotaPeriodo = cuotaDe(periodo)
  const status = computePeriodStatus(payments, periodo, Number(d.saldoRestante))

  const montoAdelantado = payments.filter(p => p.periodo === periodoSiguiente).reduce((s, p) => s + Number(p.montoPagado), 0)

  // Nunca se pide por atrasos más de lo que de verdad queda debiendo (ej. una
  // deuda de una sola cuota que no se pagó: el atraso es el saldo, no más).
  let restante = Number(d.saldoRestante)
  const atrasos = calcularAtrasos(d, payments)
    .map(a => {
      const falta = Math.round(Math.min(a.falta, restante) * 100) / 100
      restante = Math.max(0, restante - falta)
      return { ...a, falta }
    })
    .filter(a => a.falta > 0.009)

  return {
    ...d,
    montoTotal: Number(d.montoTotal),
    saldoRestante: Number(d.saldoRestante),
    cuotaPeriodo,
    // Cuota normal (sin el ajuste "solo este periodo") — para mostrar "normal: $X".
    cuotaBase: Number(d.cuotaPeriodo),
    cuotaAjustadaEstePeriodo: d.cuotaOverride != null && d.cuotaOverridePeriodo === periodo,
    cuotaOverride: d.cuotaOverride != null ? Number(d.cuotaOverride) : null,
    tasaInteres: d.tasaInteres ? Number(d.tasaInteres) : null,
    pagadoEstePeriodo: status.montoPagadoEstePeriodo >= cuotaPeriodo,
    montoPagadoEstePeriodo: status.montoPagadoEstePeriodo > 0 ? status.montoPagadoEstePeriodo : null,
    montoParticipanteA: d.montoParticipanteA ? Number(d.montoParticipanteA) : null,
    montoParticipanteB: d.montoParticipanteB ? Number(d.montoParticipanteB) : null,
    pendienteProximoPeriodo: esPendienteProximoPeriodo(d.activoDesdePeriodo, periodo),
    pagosPeriodo: resumenPagosPeriodo(payments, periodo),
    // Pago adelantado de la PRÓXIMA cuota (ver "Adelantar próxima cuota").
    periodoSiguiente,
    montoAdelantado: montoAdelantado > 0 ? montoAdelantado : null,
    proximaCuotaCubierta: montoAdelantado > 0 && montoAdelantado >= cuotaDe(periodoSiguiente),
    // Cuotas de periodos ya cerrados que quedaron sin cubrir.
    atrasos,
    montoAtrasado: Math.round(atrasos.reduce((s, a) => s + a.falta, 0) * 100) / 100,
    ...extra,
  }
}

/** Atajo para responder UNA deuda (PATCH, undo-pay…). */
export async function serializarUnaDeuda(debtId: string, extra: Record<string, unknown> = {}) {
  const d = await prisma.debt.findUniqueOrThrow({ where: { id: debtId } })
  return serializarDeuda(d, await cargarContextoDeudas([d]), extra)
}
