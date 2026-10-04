import { randomUUID } from 'crypto'
import { prisma } from '../config/database.js'
import { planPocketDeduction } from './wallet.js'
import { debtPeriodo, debtPeriodoSiguiente, computePeriodStatus, calcularPagoDeuda, calcularAtrasos, cuotaBaseDelPeriodo, periodosRevisables, tasaDelPeriodo, esLineaCredito, estadoTrasPago, cupoDisponible } from './debt-calc.js'
import { cuotaEfectivaTarjeta, cuotaExigibleLinea, allocateCardPayment } from './installments.js'
import { recordMissionAction } from './missions.js'
import { serializarUnaDeuda } from './debt-view.js'
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
  /** Línea de crédito que quedó en $0 (sigue activa: su cupo queda libre). */
  enCeros: boolean
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
  const esLinea = esLineaCredito(existing.tipoDeuda)
  const cuotaBase = cuotaBaseDelPeriodo(existing, periodo)
  const installments = esLinea ? await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debtId } }) : []

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
  const primerPago = paymentsThisPeriod.reduce<Date | null>((min, p) => !min || p.createdAt < min ? p.createdAt : min, null)
  // Compras de este periodo: todavía no generan interés (llegan en el próximo extracto)
  const comprasDelPeriodo = installments
    .filter(p => debtPeriodo(existing, p.createdAt) === periodo)
    .reduce((s, p) => s + Math.max(0, Number(p.cuotaMensual) * p.cuotasTotal - Number(p.montoAbonado)), 0)
  const cuotaVigente = esLinea
    ? cuotaExigibleLinea(cuotaEfectivaTarjeta(cuotaBase, installments, { tarjeta: existing, periodo }), status.saldoAlIniciarPeriodo, installments, { tarjeta: existing, periodo }, primerPago)
    : cuotaBase

  // Lo máximo que tiene sentido pagar: el saldo más el interés pendiente del
  // periodo. Antes un pago mayor dejaba la deuda en 0 pero descontaba TODO de
  // la billetera (pagar $99M a una deuda de $2M borraba $97M que no existían).
  // Con el saldo real del banco se acepta: el saldo de Kiri puede estar atrasado.
  // Las tarjetas quedan por fuera: pagarle al banco más de lo que Kiri conoce
  // es normal (compras que no se registraron) y esa plata sí salió.
  const esPrestamo = !esLinea
  const maximo = Math.round((currentSaldo + calcularPagoDeuda(currentSaldo, tasaPeriodo, status, Number.MAX_SAFE_INTEGER).pagoInteres) * 100) / 100
  if (esPrestamo && montoInput !== undefined && opciones.saldoReal === undefined && montoInput > maximo + 1) {
    throw new PagoExcedeSaldoError(maximo)
  }
  // Sin monto explícito se paga lo que FALTA del periodo, no la cuota completa
  // de nuevo (una cuota atrasada puede tener un abono parcial previo), y en un
  // préstamo nunca más de lo que queda (la última cuota suele ser menor).
  const faltaDelPeriodo = Math.round((cuotaVigente - (esPeriodoActual ? 0 : yaPagado)) * 100) / 100
  const montoPago = montoInput ?? Math.max(0.01, esPrestamo ? Math.min(maximo, faltaDelPeriodo) : faltaDelPeriodo)

  let { pagoInteres, abonoCapital, nuevoSaldo } = calcularPagoDeuda(currentSaldo, tasaPeriodo, status, montoPago)
  // En una tarjeta sin tasa registrada, Kiri no inventa intereses: todo el pago va a capital
  // hasta que el usuario dé el saldo del banco (ahí se ve lo que de verdad cobraron).

  // Saldo real del banco: manda sobre la estimación con la tasa registrada.
  // Lo que bajó el saldo es abono a capital; el resto del pago fueron
  // intereses y cargos (en una tarjeta: intereses, cuota de manejo, seguros).
  let tasaObservadaMensual: number | null = null
  if (opciones.saldoReal !== undefined) {
    nuevoSaldo = Math.max(0, Math.round(opciones.saldoReal * 100) / 100)
    abonoCapital = Math.round((currentSaldo - nuevoSaldo) * 100) / 100
    pagoInteres = Math.max(0, Math.round((montoPago - abonoCapital) * 100) / 100)
    // Aprender la tasa real con el PRIMER pago del periodo (el interés del
    // periodo se causa sobre el saldo con que arrancó). En una línea de
    // crédito, las compras de este periodo todavía no generan interés: la
    // base es el saldo sin ellas.
    const base = esLinea ? currentSaldo - comprasDelPeriodo : currentSaldo
    if (status.montoPagadoEstePeriodo === 0 && base > 0 && pagoInteres > 0) {
      const tasaPeriodo = (pagoInteres / base) * 100
      const mensual = Math.round((existing.frecuenciaPago === 'quincenal' ? tasaPeriodo * 2 : tasaPeriodo) * 10000) / 10000
      if (mensual <= TASA_OBSERVADA_MAX) tasaObservadaMensual = mensual
    }
  }
  const nuevoEstado = estadoTrasPago(existing.tipoDeuda, nuevoSaldo)

  const totalPaidThisPeriod = status.montoPagadoEstePeriodo + montoPago
  const faltaCuota = Math.round((cuotaVigente - totalPaidThisPeriod) * 100) / 100
  const cuotaAjustada = !!opciones.cuotaCompleta && faltaCuota > 0
  const cuotaCubierta = totalPaidThisPeriod >= cuotaVigente || cuotaAjustada

  const walletDeductionData = planPocketDeduction('obligaciones', montoPago)

  const paymentId = randomUUID()
  const allocationOps = esLinea
    ? await allocateCardPayment(debtId, paymentId, Math.max(0, abonoCapital))
    : []

  // "Quedó pagada la cuota" con otro valor: en un préstamo, la cuota de ESTE
  // periodo pasa a ser lo pagado (el siguiente vuelve a la normal, igual que
  // "Solo este mes"); en una tarjeta, cuya cuota incluye planes de cuotas, se
  // cubre la diferencia con un marcador que no mueve saldo ni billetera.
  const ajusteOps = !cuotaAjustada
    ? []
    : esLinea
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
        ...(cuotaAjustada && !esLinea ? { cuotaOverride: totalPaidThisPeriod, cuotaOverridePeriodo: periodo } : {}),
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
        saldoBanco: opciones.saldoReal !== undefined ? nuevoSaldo : null,
      },
    }),
    prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
    ...allocationOps,
  ])

  await recordMissionAction(userId, 'pagar_obligacion')

  // Misma forma que GET /debts (cupo, disponible, cuota exigible…)
  const vista = await serializarUnaDeuda(debtId)

  const debtName = existing.nombre
  const enCeros = esLinea && nuevoSaldo <= 0
  const disponible = esLinea ? cupoDisponible(existing.cupoTotal != null ? Number(existing.cupoTotal) : null, nuevoSaldo) : null
  sendPushToUser(userId, {
    title: nuevoEstado === 'saldada' ? '🎉 ¡Deuda liquidada!' : enCeros ? `💳 ¡${debtName} en ceros!` : '✅ Pago registrado',
    body: nuevoEstado === 'saldada'
      ? `¡Felicidades! Terminaste de pagar "${debtName}".`
      : enCeros
        ? (disponible != null ? `Tu cupo de $${disponible.toLocaleString('es-CO')} quedó libre.` : 'No le debes nada. Sigue disponible para tus compras.')
        : `Pagaste $${montoPago.toLocaleString('es-CO')} de "${debtName}". Saldo restante: $${nuevoSaldo.toLocaleString('es-CO')}`,
    tag: 'debt-payment',
    url: '/obligaciones',
  }).catch(() => {})

  return {
    debt: {
      ...vista,
      pagadoEstePeriodo: vista.pagadoEstePeriodo || cuotaCubierta,
      montoPagadoEstePeriodo: totalPaidThisPeriod > 0 ? totalPaidThisPeriod : null,
      pagosPeriodo: { cantidad: paymentsThisPeriod.length + 1, ultimoMonto: montoPago, ultimoEsMarcador: false },
    },
    amortizacion: { montoPagado: montoPago, pagoInteres, abonoCapital },
    pagado: montoPago,
    saldoAnterior: currentSaldo,
    saldoNuevo: nuevoSaldo,
    liquidada: nuevoEstado === 'saldada',
    enCeros,
    periodo,
    esPeriodoActual,
    tasaObservadaMensual,
    cuotaAjustada,
  }
}
