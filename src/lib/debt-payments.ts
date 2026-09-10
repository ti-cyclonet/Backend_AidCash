import { randomUUID } from 'crypto'
import { prisma } from '../config/database.js'
import { planPocketDeduction } from './wallet.js'
import { debtPeriodo, computePeriodStatus, calcularPagoDeuda } from './debt-calc.js'
import { cuotaEfectivaTarjeta, allocateCardPayment } from './installments.js'
import { recordMissionAction } from './missions.js'
import { sendPushToUser } from './push.js'

export interface PayDebtResult {
  debt: {
    id: string
    montoTotal: number
    saldoRestante: number
    cuotaPeriodo: number
    pagadoEstePeriodo: boolean
    montoPagadoEstePeriodo: number | null
    tasaInteres: number | null
    estado: string
    nombre: string
    [key: string]: unknown
  }
  amortizacion: { montoPagado: number; pagoInteres: number; abonoCapital: number }
  pagado: number
  saldoAnterior: number
  saldoNuevo: number
  liquidada: boolean
}

/**
 * Registra el pago de la cuota de una deuda — misma lógica exacta que usa
 * POST /debts/:id/pay, extraída para que el cron de pago automático (ver
 * lib/auto-pay.ts) pueda ejecutar un pago real sin pasar por HTTP y sin
 * duplicar la lógica de amortización/interés/asignación a tarjeta en dos
 * sitios (el riesgo de que un pago manual y uno automático calcen distinto
 * es justo el tipo de bug que este proyecto ya arrastraba en otros lados).
 *
 * Devuelve `null` si la deuda no existe/no está activa — quien llama decide
 * qué hacer con eso (404 en la ruta HTTP, skip silencioso en el cron).
 */
export async function payDebtServer(userId: string, debtId: string, montoInput?: number): Promise<PayDebtResult | null> {
  const existing = await prisma.debt.findFirst({ where: { id: debtId, userId, estado: 'activa' } })
  if (!existing) return null

  // Para una tarjeta de crédito, la cuota real de este periodo es la base MÁS
  // los planes de pay-with-card vigentes (misma cuenta que GET /debts) — usar
  // solo la columna base haría que pagarla marcara la tarjeta como "pagada"
  // aunque quedara pendiente todo lo financiado con ella ese periodo.
  const cuotaVigente = existing.tipoDeuda === 'TARJETA_CREDITO'
    ? cuotaEfectivaTarjeta(Number(existing.cuotaPeriodo), await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debtId } }))
    : Number(existing.cuotaPeriodo)

  const montoPago = montoInput ?? cuotaVigente
  const currentSaldo = Number(existing.saldoRestante)

  const tasaMensual = existing.tasaInteresAplicada
    ? Number(existing.tasaInteresAplicada)
    : existing.tasaInteres
      ? Number(existing.tasaInteres)
      : null

  const periodo = debtPeriodo(existing)
  const paymentsThisPeriod = await prisma.debtPayment.findMany({ where: { debtId, periodo } })
  const status = computePeriodStatus(paymentsThisPeriod, periodo, currentSaldo)

  const { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado } = calcularPagoDeuda(currentSaldo, tasaMensual, status, montoPago)

  const totalPaidThisPeriod = status.montoPagadoEstePeriodo + montoPago
  const cuotaCubierta = totalPaidThisPeriod >= cuotaVigente

  const walletDeductionData = planPocketDeduction('obligaciones', montoPago)

  const paymentId = randomUUID()
  const allocationOps = existing.tipoDeuda === 'TARJETA_CREDITO'
    ? await allocateCardPayment(debtId, paymentId, abonoCapital)
    : []

  const [debt] = await prisma.$transaction([
    prisma.debt.update({
      where: { id: debtId },
      data: { saldoRestante: nuevoSaldo, estado: nuevoEstado },
    }),
    prisma.debtPayment.create({
      data: {
        id: paymentId,
        debtId,
        montoPagado: montoPago,
        abonoCapital,
        pagoInteres,
        saldoAnterior: currentSaldo,
        saldoPosterior: nuevoSaldo,
        periodo,
      },
    }),
    prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
    ...allocationOps,
  ])

  await recordMissionAction(userId, 'pagar_obligacion')

  const cuotaPeriodoRespuesta = debt.tipoDeuda === 'TARJETA_CREDITO'
    ? cuotaEfectivaTarjeta(Number(debt.cuotaPeriodo), await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debtId } }))
    : Number(debt.cuotaPeriodo)

  const debtName = existing.nombre
  sendPushToUser(userId, {
    title: nuevoEstado === 'saldada' ? '🎉 ¡Deuda liquidada!' : '✅ Pago registrado',
    body: nuevoEstado === 'saldada'
      ? `¡Felicidades! Terminaste de pagar "${debtName}".`
      : `Pagaste $${montoPago.toLocaleString('es-CO')} de "${debtName}". Saldo restante: $${nuevoSaldo.toLocaleString('es-CO')}`,
    tag: 'debt-payment',
    url: '/obligaciones',
  }).catch(() => {})

  return {
    debt: {
      ...debt,
      montoTotal: Number(debt.montoTotal),
      saldoRestante: Number(debt.saldoRestante),
      cuotaPeriodo: cuotaPeriodoRespuesta,
      pagadoEstePeriodo: cuotaCubierta,
      montoPagadoEstePeriodo: totalPaidThisPeriod > 0 ? totalPaidThisPeriod : null,
      tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
    },
    amortizacion: { montoPagado: montoPago, pagoInteres, abonoCapital },
    pagado: montoPago,
    saldoAnterior: currentSaldo,
    saldoNuevo: nuevoSaldo,
    liquidada: nuevoEstado === 'saldada',
  }
}
