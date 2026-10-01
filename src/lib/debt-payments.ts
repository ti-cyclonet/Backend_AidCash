import { randomUUID } from 'crypto'
import { prisma } from '../config/database.js'
import { planPocketDeduction } from './wallet.js'
import { debtPeriodo, debtPeriodoSiguiente, computePeriodStatus, calcularPagoDeuda, calcularAtrasos, cuotaBaseDelPeriodo, periodosRevisables, tasaDelPeriodo } from './debt-calc.js'
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
  /** Periodo al que quedó asignado el pago (puede ser el siguiente o uno atrasado). */
  periodo: string
  esPeriodoActual: boolean
  /** Si el usuario dio el saldo real del banco: tasa mensual que resultó (y se guardó como tasa aplicada). */
  tasaObservadaMensual: number | null
  /** La cuota del periodo se dio por cubierta con un monto distinto (ver `cuotaCompleta`). */
  cuotaAjustada: boolean
}

export interface OpcionesPago {
  /**
   * Saldo que quedó según el banco después de este pago. Si viene, manda
   * sobre el cálculo de Kiri: lo que bajó el saldo es abono a capital y el
   * resto del pago fue interés. Antes el interés salía SIEMPRE de la tasa
   * registrada y el saldo de Kiri se alejaba del saldo real del banco.
   */
  saldoReal?: number
  /**
   * "Con este valor quedó pagada la cuota" — ej. la cuota llegó en $180.000
   * y no en $182.000: el periodo queda cubierto sin dejar $2.000 pendientes.
   */
  cuotaCompleta?: boolean
}

/** Tasa mensual máxima que se acepta como "observada" (más que esto es un saldo mal digitado, no un interés). */
const TASA_OBSERVADA_MAX = 15

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
/** El periodo pedido no es ni el actual, ni el siguiente, ni una cuota atrasada de esta deuda. */
export class PeriodoInvalidoError extends Error {}

/** Se intentó pagar más de lo que se debe (saldo + interés del periodo). */
export class PagoExcedeSaldoError extends Error {
  constructor(public maximo: number) { super(`Ese pago es mayor que lo que queda de la deuda ($${maximo.toLocaleString('es-CO')}). Revisa el valor.`) }
}

/**
 * A qué periodo va el pago:
 *  - 'actual' (default): la cuota del periodo en curso, como siempre.
 *  - 'siguiente': adelantar la próxima cuota — antes pagar "antes de tiempo"
 *    (ej. el 30 la cuota del 1) quedaba en el periodo en curso y la próxima
 *    cuota salía sin pagar al cambiar de periodo.
 *  - un string de periodo pasado: pagar una cuota atrasada (ver calcularAtrasos).
 */
export type DestinoPago = 'actual' | 'siguiente' | string

export async function resolverPeriodoDestino(
  debt: Parameters<typeof calcularAtrasos>[0] & { id: string },
  destino: DestinoPago = 'actual',
): Promise<string> {
  if (destino === 'actual') return debtPeriodo(debt)
  if (destino === 'siguiente') return debtPeriodoSiguiente(debt)
  const revisables = periodosRevisables(debt)
  if (!revisables.includes(destino)) throw new PeriodoInvalidoError('Periodo no válido para esta deuda')
  const pagos = await prisma.debtPayment.findMany({ where: { debtId: debt.id, periodo: destino } })
  if (calcularAtrasos(debt, pagos).length === 0) throw new PeriodoInvalidoError('Esa cuota no está atrasada')
  return destino
}

export async function payDebtServer(userId: string, debtId: string, montoInput?: number, destino: DestinoPago = 'actual', opciones: OpcionesPago = {}): Promise<PayDebtResult | null> {
  const existing = await prisma.debt.findFirst({ where: { id: debtId, userId, estado: 'activa' } })
  if (!existing) return null

  const periodo = await resolverPeriodoDestino(existing, destino)
  const esPeriodoActual = periodo === debtPeriodo(existing)

  // Para una tarjeta de crédito, la cuota real de este periodo es la base MÁS
  // los planes de pay-with-card vigentes (misma cuenta que GET /debts) — usar
  // solo la columna base haría que pagarla marcara la tarjeta como "pagada"
  // aunque quedara pendiente todo lo financiado con ella ese periodo.
  const cuotaBase = cuotaBaseDelPeriodo(existing, periodo)
  const cuotaVigente = existing.tipoDeuda === 'TARJETA_CREDITO'
    ? cuotaEfectivaTarjeta(cuotaBase, await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debtId } }), { tarjeta: existing, periodo })
    : cuotaBase

  const paymentsThisPeriod = await prisma.debtPayment.findMany({ where: { debtId, periodo } })
  const yaPagado = paymentsThisPeriod.reduce((s, p) => s + Number(p.montoPagado), 0)
  const currentSaldo = Number(existing.saldoRestante)

  const tasaMensual = existing.tasaInteresAplicada
    ? Number(existing.tasaInteresAplicada)
    : existing.tasaInteres
      ? Number(existing.tasaInteres)
      : null

  const status = computePeriodStatus(paymentsThisPeriod, periodo, currentSaldo)
  const tasaPeriodo = tasaDelPeriodo(tasaMensual, existing.frecuenciaPago)

  // Lo máximo que tiene sentido pagar: el saldo más el interés pendiente del
  // periodo. Antes un pago mayor dejaba la deuda en 0 pero descontaba TODO de
  // la billetera (pagar $99M a una deuda de $2M borraba $97M que no existían).
  // Con el saldo real del banco se acepta: el saldo de Kiri puede estar atrasado.
  // Las tarjetas quedan por fuera: pagarle al banco más de lo que Kiri conoce
  // es normal (compras que no se registraron) y esa plata sí salió.
  const esPrestamo = existing.tipoDeuda !== 'TARJETA_CREDITO'
  const maximo = Math.round((currentSaldo + calcularPagoDeuda(currentSaldo, tasaPeriodo, status, Number.MAX_SAFE_INTEGER).pagoInteres) * 100) / 100
  if (esPrestamo && montoInput !== undefined && opciones.saldoReal === undefined && montoInput > maximo + 1) {
    throw new PagoExcedeSaldoError(maximo)
  }
  // Sin monto explícito se paga lo que FALTA del periodo, no la cuota completa
  // de nuevo (una cuota atrasada puede tener un abono parcial previo), y en un
  // préstamo nunca más de lo que queda (la última cuota suele ser menor).
  const faltaDelPeriodo = Math.round((cuotaVigente - (esPeriodoActual ? 0 : yaPagado)) * 100) / 100
  const montoPago = montoInput ?? Math.max(0.01, esPrestamo ? Math.min(maximo, faltaDelPeriodo) : faltaDelPeriodo)

  let { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado } = calcularPagoDeuda(currentSaldo, tasaPeriodo, status, montoPago)

  // Saldo real del banco: manda sobre la estimación con la tasa registrada.
  let tasaObservadaMensual: number | null = null
  if (opciones.saldoReal !== undefined) {
    nuevoSaldo = Math.max(0, Math.round(opciones.saldoReal * 100) / 100)
    abonoCapital = Math.round((currentSaldo - nuevoSaldo) * 100) / 100
    pagoInteres = Math.max(0, Math.round((montoPago - abonoCapital) * 100) / 100)
    nuevoEstado = nuevoSaldo <= 0 ? 'saldada' : 'activa'
    // Aprender la tasa real: solo con el PRIMER pago del periodo (el interés
    // del periodo se causa sobre el saldo con que arrancó) y no en tarjetas,
    // cuyo saldo también cambia por compras nuevas.
    if (status.montoPagadoEstePeriodo === 0 && currentSaldo > 0 && pagoInteres > 0 && existing.tipoDeuda !== 'TARJETA_CREDITO') {
      const tasaPeriodo = (pagoInteres / currentSaldo) * 100
      const mensual = Math.round((existing.frecuenciaPago === 'quincenal' ? tasaPeriodo * 2 : tasaPeriodo) * 10000) / 10000
      if (mensual <= TASA_OBSERVADA_MAX) tasaObservadaMensual = mensual
    }
  }

  const totalPaidThisPeriod = status.montoPagadoEstePeriodo + montoPago
  const faltaCuota = Math.round((cuotaVigente - totalPaidThisPeriod) * 100) / 100
  const cuotaAjustada = !!opciones.cuotaCompleta && faltaCuota > 0
  const cuotaCubierta = totalPaidThisPeriod >= cuotaVigente || cuotaAjustada

  const walletDeductionData = planPocketDeduction('obligaciones', montoPago)

  const paymentId = randomUUID()
  const allocationOps = existing.tipoDeuda === 'TARJETA_CREDITO'
    ? await allocateCardPayment(debtId, paymentId, Math.max(0, abonoCapital))
    : []

  // "Quedó pagada la cuota" con otro valor: en un préstamo, la cuota de ESTE
  // periodo pasa a ser lo pagado (el siguiente vuelve a la normal, igual que
  // "Solo este mes"); en una tarjeta, cuya cuota incluye planes de cuotas, se
  // cubre la diferencia con un marcador que no mueve saldo ni billetera.
  const ajusteOps = !cuotaAjustada
    ? []
    : existing.tipoDeuda === 'TARJETA_CREDITO'
      ? [prisma.debtPayment.create({
          data: { debtId, montoPagado: faltaCuota, abonoCapital: 0, pagoInteres: 0, saldoAnterior: nuevoSaldo, saldoPosterior: nuevoSaldo, periodo, esMarcador: true, createdAt: new Date(Date.now() - 1) },
        })]
      : []

  const [debt] = await prisma.$transaction([
    prisma.debt.update({
      where: { id: debtId },
      data: {
        saldoRestante: nuevoSaldo,
        estado: nuevoEstado,
        ...(tasaObservadaMensual !== null ? { tasaInteresAplicada: tasaObservadaMensual } : {}),
        ...(cuotaAjustada && existing.tipoDeuda !== 'TARJETA_CREDITO' ? { cuotaOverride: totalPaidThisPeriod, cuotaOverridePeriodo: periodo } : {}),
      },
    }),
    ...ajusteOps,
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
    ? cuotaEfectivaTarjeta(cuotaBase, await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debtId } }), { tarjeta: existing, periodo })
    : cuotaBase

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
      pagosPeriodo: { cantidad: paymentsThisPeriod.length + 1, ultimoMonto: montoPago, ultimoEsMarcador: false },
    },
    amortizacion: { montoPagado: montoPago, pagoInteres, abonoCapital },
    pagado: montoPago,
    saldoAnterior: currentSaldo,
    saldoNuevo: nuevoSaldo,
    liquidada: nuevoEstado === 'saldada',
    periodo,
    esPeriodoActual,
    tasaObservadaMensual,
    cuotaAjustada,
  }
}
