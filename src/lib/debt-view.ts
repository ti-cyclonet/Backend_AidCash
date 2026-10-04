import { prisma } from '../config/database.js'
import { esPendienteProximoPeriodo } from './period.js'
import {
  debtPeriodo, debtPeriodoSiguiente, computePeriodStatus, resumenPagosPeriodo,
  cuotaBaseDelPeriodo, calcularAtrasos, periodosRevisables, esLineaCredito, cupoDisponible,
} from './debt-calc.js'
import { cuotaEfectivaTarjeta, cuotaExigibleLinea } from './installments.js'
import type { Debt, DebtAjuste, DebtCardInstallment, DebtPayment, Prisma } from '@prisma/client'

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
  const lineaIds = debts.filter(d => esLineaCredito(d.tipoDeuda)).map(d => d.id)
  const hace120 = new Date(Date.now() - 120 * 86_400_000)
  const [payments, installments, ajustes, pagosConBanco] = await Promise.all([
    debts.length > 0
      ? prisma.debtPayment.findMany({ where: { debtId: { in: debts.map(d => d.id) }, periodo: { in: periodos } } })
      : Promise.resolve([] as DebtPayment[]),
    lineaIds.length > 0
      ? prisma.debtCardInstallment.findMany({ where: { tarjetaId: { in: lineaIds } } })
      : Promise.resolve([] as DebtCardInstallment[]),
    // Intereses detectados (Actualizar saldo) y pagos con el saldo del banco
    lineaIds.length > 0
      ? prisma.debtAjuste.findMany({ where: { debtId: { in: lineaIds }, tipo: 'interes', createdAt: { gte: hace120 } } })
      : Promise.resolve([] as DebtAjuste[]),
    lineaIds.length > 0
      ? prisma.debtPayment.findMany({ where: { debtId: { in: lineaIds }, saldoBanco: { not: null }, pagoInteres: { gt: 0 }, createdAt: { gte: hace120 } }, select: { debtId: true, periodo: true, pagoInteres: true } })
      : Promise.resolve([] as { debtId: string; periodo: string; pagoInteres: Prisma.Decimal }[]),
  ])
  const paymentsByDebt = new Map<string, DebtPayment[]>()
  for (const p of payments) paymentsByDebt.set(p.debtId, [...(paymentsByDebt.get(p.debtId) ?? []), p])
  const installmentsByTarjeta = new Map<string, DebtCardInstallment[]>()
  for (const i of installments) installmentsByTarjeta.set(i.tarjetaId, [...(installmentsByTarjeta.get(i.tarjetaId) ?? []), i])
  // Interés detectado por deuda y periodo
  const interesesByDebt = new Map<string, Map<string, number>>()
  const sumar = (debtId: string, periodo: string, monto: number) => {
    const m = interesesByDebt.get(debtId) ?? new Map<string, number>()
    m.set(periodo, Math.round(((m.get(periodo) ?? 0) + monto) * 100) / 100)
    interesesByDebt.set(debtId, m)
  }
  for (const a of ajustes) sumar(a.debtId, a.periodo, Number(a.monto))
  for (const p of pagosConBanco) sumar(p.debtId, p.periodo, Number(p.pagoInteres))
  return { paymentsByDebt, installmentsByTarjeta, interesesByDebt }
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

  const esLinea = esLineaCredito(d.tipoDeuda)
  const cuotaDe = (p: string) => {
    const base = cuotaBaseDelPeriodo(d, p)
    return esLinea ? cuotaEfectivaTarjeta(base, installments, { tarjeta: d, periodo: p }) : base
  }
  const status = computePeriodStatus(payments, periodo, Number(d.saldoRestante))
  const primerPago = payments.filter(p => p.periodo === periodo).reduce<Date | null>((min, p) => !min || p.createdAt < min ? p.createdAt : min, null)
  const cuotaPeriodo = esLinea
    ? cuotaExigibleLinea(cuotaDe(periodo), status.saldoAlIniciarPeriodo, installments, { tarjeta: d, periodo }, primerPago)
    : cuotaDe(periodo)
  const saldo = Number(d.saldoRestante)
  const cupo = d.cupoTotal != null ? Number(d.cupoTotal) : null
  const disponible = esLinea ? cupoDisponible(cupo, saldo) : null

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
    tasaInteresAplicada: d.tasaInteresAplicada != null ? Number(d.tasaInteresAplicada) : null,
    // Línea de crédito (tarjeta / crédito de compras): cupo, ocupado y disponible
    esLineaCredito: esLinea,
    cupoTotal: cupo,
    cupoDisponible: disponible,
    cupoUsoPct: esLinea && cupo && cupo > 0 ? Math.round((saldo / cupo) * 100) : null,
    // Último mes en que se detectaron intereses y cargos (con el saldo del banco)
    ultimoInteres: (() => {
      const m = ctx.interesesByDebt.get(d.id)
      if (!m || m.size === 0) return null
      const periodoUlt = [...m.keys()].sort().pop()!
      return { periodo: periodoUlt, monto: m.get(periodoUlt)! }
    })(),
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

/**
 * Aviso tras una compra o pago con una línea de crédito: solo avisa, nunca
 * bloquea (el banco puede haber subido el cupo). null si no tiene cupo
 * registrado o si queda por debajo del 80%.
 */
export function avisoDeCupo(d: { nombre: string; cupoTotal: number | null; cupoDisponible: number | null; cupoUsoPct: number | null }) {
  if (d.cupoTotal == null || d.cupoDisponible == null || d.cupoUsoPct == null) return null
  if (d.cupoDisponible < 0) {
    return { nivel: 'excedido' as const, usoPct: d.cupoUsoPct, disponible: d.cupoDisponible, mensaje: `Te pasaste del cupo de ${d.nombre} por $${Math.round(-d.cupoDisponible).toLocaleString('es-CO')}. Si tu banco te subió el cupo, actualízalo en Obligaciones.` }
  }
  if (d.cupoUsoPct >= 80) {
    return { nivel: 'alto' as const, usoPct: d.cupoUsoPct, disponible: d.cupoDisponible, mensaje: `${d.nombre} va en el ${d.cupoUsoPct}% de su cupo: te quedan $${Math.round(d.cupoDisponible).toLocaleString('es-CO')} disponibles.` }
  }
  return null
}

/** Atajo para responder UNA deuda (PATCH, undo-pay…). */
export async function serializarUnaDeuda(debtId: string, extra: Record<string, unknown> = {}) {
  const d = await prisma.debt.findUniqueOrThrow({ where: { id: debtId } })
  return serializarDeuda(d, await cargarContextoDeudas([d]), extra)
}
