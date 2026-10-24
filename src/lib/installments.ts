import { prisma } from '../config/database.js'
import { planPocketCredit } from './wallet.js'
import { debtPeriodo } from './debt-calc.js'
import type { Prisma } from '@prisma/client'

/**
 * Cuota efectiva de una tarjeta: la cuota base más los planes de cuotas de
 * pay-with-card que TODAVÍA no se han pagado por completo. Antes un plan
 * dejaba de sumar por tiempo transcurrido (createdAt + cuotasTotal meses),
 * sin importar si de verdad se había pagado — el saldo real seguía debiéndose
 * pero la cuota sugerida lo "olvidaba" en silencio. Ahora solo deja de sumar
 * cuando montoAbonado alcanza el total del plan.
 *
 * Una compra con la tarjeta empieza a cobrarse en el periodo SIGUIENTE al de
 * la compra (llega en el próximo extracto). Antes sumaba de inmediato a la
 * cuota del periodo en curso: si ya se había pagado la tarjeta este mes, al
 * comprar algo volvía a "Pago parcial" y le faltaba la cuota de esa compra.
 */
export function cuotaEfectivaTarjeta(
  cuotaBase: number,
  installments: { cuotaMensual: Prisma.Decimal | number; cuotasTotal: number; montoAbonado: Prisma.Decimal | number; createdAt: Date }[],
  cobro: { tarjeta: { frecuenciaPago: string; diasPago: string }; periodo: string },
): number {
  const activos = installments.filter(p =>
    Number(p.montoAbonado) < Number(p.cuotaMensual) * p.cuotasTotal
    && debtPeriodo(cobro.tarjeta, p.createdAt) < cobro.periodo)
  const sumaActivos = activos.reduce((s, p) => s + cuotaDelPlanPorPeriodo(p, cobro.tarjeta), 0)
  return Math.round((cuotaBase + sumaActivos) * 100) / 100
}

/**
 * Lo que un plan de cuotas suma a la cuota de la tarjeta en UN periodo de
 * cobro. `cuotaMensual` es el monto / cuotas (meses); en una tarjeta quincenal
 * cada quincena cobra la mitad — antes sumaba la cuota mensual entera en cada
 * quincena y la compra se cobraba al doble de rápido.
 */
export function cuotaDelPlanPorPeriodo(plan: { cuotaMensual: Prisma.Decimal | number }, tarjeta: { frecuenciaPago: string }): number {
  const cuota = Number(plan.cuotaMensual)
  return Math.round((tarjeta.frecuenciaPago === 'quincenal' ? cuota / 2 : cuota) * 100) / 100
}

/**
 * Cuota que de verdad se exige a una línea de crédito en el periodo: la cuota
 * efectiva, pero nunca más de lo que se debía al arrancar el periodo sin
 * contar las compras hechas EN este periodo (esas llegan en el próximo
 * extracto). Así una tarjeta en $0 queda "Al día" en vez de pedir su cuota
 * habitual, y una con poco saldo pide solo ese saldo.
 */
export function cuotaExigibleLinea(
  cuotaEfectiva: number,
  saldoAlIniciarPeriodo: number,
  installments: { cuotaMensual: Prisma.Decimal | number; cuotasTotal: number; montoAbonado: Prisma.Decimal | number; createdAt: Date }[],
  cobro: { tarjeta: { frecuenciaPago: string; diasPago: string }; periodo: string },
  /** Fecha del primer pago del periodo: las compras posteriores no están en `saldoAlIniciarPeriodo`. */
  primerPagoEn: Date | null = null,
): number {
  const comprasDelPeriodo = installments
    .filter(p => debtPeriodo(cobro.tarjeta, p.createdAt) === cobro.periodo && (!primerPagoEn || p.createdAt < primerPagoEn))
    .reduce((s, p) => s + Math.max(0, Number(p.cuotaMensual) * p.cuotasTotal - Number(p.montoAbonado)), 0)
  const facturado = Math.max(0, saldoAlIniciarPeriodo - comprasDelPeriodo)
  return Math.round(Math.min(cuotaEfectiva, facturado) * 100) / 100
}

/**
 * Reparte el abono a capital de un pago sobre la propia tarjeta entre sus
 * planes de cuotas, respetando las cuotas: primero cubre lo que cada plan
 * cobra EN ESTE periodo (su cuota, menos lo que otros pagos del mismo periodo
 * ya le dieron), después el saldo de la tarjeta que no es de ningún plan, y
 * solo lo que sobre de ahí adelanta planes (el más antiguo primero) — p. ej.
 * cuando se paga el total de la tarjeta.
 *
 * Antes todo el abono iba al plan más antiguo hasta agotarlo: pagar la cuota
 * del mes de una tarjeta con una compra a 6 cuotas daba la compra por pagada
 * entera y desde el mes siguiente la cuota "olvidaba" las 5 que faltaban.
 *
 * Cada porción queda registrada en DebtPaymentAllocation para que undo-pay
 * pueda revertirla con precisión más adelante. Debe llamarse ANTES del
 * $transaction que crea el DebtPayment, pasándole el id ya generado
 * (randomUUID) para poder enlazar las asignaciones — mismo patrón que ya usa
 * pay-with-card con el id del installment.
 */
export async function allocateCardPayment(
  tarjeta: { id: string; frecuenciaPago: string; diasPago: string },
  debtPaymentId: string,
  abonoCapital: number,
  periodo: string,
  saldoAntes: number,
): Promise<Prisma.PrismaPromise<unknown>[]> {
  if (abonoCapital <= 0) return []

  const r2 = (n: number) => Math.round(n * 100) / 100
  const planes = (await prisma.debtCardInstallment.findMany({
    where: { tarjetaId: tarjeta.id },
    orderBy: { createdAt: 'asc' },
    include: { allocations: { where: { debtPayment: { periodo } }, select: { monto: true } } },
  }))
    .map(inst => ({
      inst,
      pendiente: r2(Number(inst.cuotaMensual) * inst.cuotasTotal - Number(inst.montoAbonado)),
      asignado: 0,
    }))
    .filter(p => p.pendiente > 0)

  let capitalLeft = r2(abonoCapital)
  const asignar = (p: (typeof planes)[number], tope: number) => {
    const applied = r2(Math.min(tope, p.pendiente - p.asignado, capitalLeft))
    if (applied <= 0) return
    p.asignado = r2(p.asignado + applied)
    capitalLeft = r2(capitalLeft - applied)
  }

  // 1) La cuota de este periodo de cada plan que ya se está cobrando
  for (const p of planes) {
    if (capitalLeft <= 0) break
    if (debtPeriodo(tarjeta, p.inst.createdAt) >= periodo) continue
    const yaCubierto = p.inst.allocations.reduce((s, a) => s + Number(a.monto), 0)
    asignar(p, cuotaDelPlanPorPeriodo(p.inst, tarjeta) - yaCubierto)
  }
  // 2) El saldo de la tarjeta que no pertenece a ningún plan
  const saldoSinPlanes = Math.max(0, r2(saldoAntes - planes.reduce((s, p) => s + p.pendiente, 0)))
  capitalLeft = r2(capitalLeft - Math.min(capitalLeft, saldoSinPlanes))
  // 3) Lo que sobre adelanta planes, el más antiguo primero
  for (const p of planes) {
    if (capitalLeft <= 0) break
    asignar(p, Number.MAX_SAFE_INTEGER)
  }

  const ops: Prisma.PrismaPromise<unknown>[] = []
  for (const p of planes) {
    if (p.asignado <= 0) continue
    ops.push(prisma.debtPaymentAllocation.create({ data: { debtPaymentId, installmentId: p.inst.id, monto: p.asignado } }))
    ops.push(prisma.debtCardInstallment.update({ where: { id: p.inst.id }, data: { montoAbonado: { increment: p.asignado } } }))
  }
  return ops
}

/**
 * Revierte las asignaciones (DebtPaymentAllocation) de un lote de pagos que se
 * está deshaciendo (undo-pay de un pago hecho directamente a la propia
 * tarjeta) — le devuelve a cada plan de cuotas el montoAbonado que ese pago
 * le había aportado. Debe llamarse ANTES de borrar los DebtPayment (una vez
 * borrados, la asignación se borra en cascada pero el montoAbonado del plan
 * ya no se puede reconstruir).
 */
export async function reverseCardPaymentAllocations(paymentIds: string[]): Promise<Prisma.PrismaPromise<unknown>[]> {
  if (paymentIds.length === 0) return []
  const allocations = await prisma.debtPaymentAllocation.findMany({ where: { debtPaymentId: { in: paymentIds } } })
  if (allocations.length === 0) return []

  const abonoByInstallment = new Map<string, number>()
  for (const a of allocations) {
    abonoByInstallment.set(a.installmentId, (abonoByInstallment.get(a.installmentId) ?? 0) + Number(a.monto))
  }
  const ops: Prisma.PrismaPromise<unknown>[] = []
  for (const [installmentId, monto] of abonoByInstallment) {
    ops.push(prisma.debtCardInstallment.update({ where: { id: installmentId }, data: { montoAbonado: { decrement: monto } } }))
  }
  return ops
}

/**
 * Revierte por completo uno o más planes de cuotas — se usa cuando se
 * deshace/borra la compra u obligación que los originó (no un simple pago a
 * la tarjeta, sino la compra entera). Dos montos distintos:
 *  - Lo que TODAVÍA no se había pagado del plan sale del saldo de la tarjeta,
 *    como siempre.
 *  - Lo que SÍ se había abonado ya (con pagos reales posteriores a la
 *    tarjeta) ya se descontó del saldo en su momento — desconectarlo de la
 *    compra ahora sin devolvérselo al usuario sería quedarse con plata que
 *    pagó de verdad por algo que ya no existe, así que se le acredita de
 *    vuelta a la billetera (bolsillo "obligaciones", de donde salió).
 *
 * Devuelve las operaciones para incluir en el mismo $transaction del llamador
 * — no ejecuta nada por sí sola.
 */
export async function buildInstallmentRevertOps(
  userId: string,
  installmentIds: string[],
): Promise<Prisma.PrismaPromise<unknown>[]> {
  if (installmentIds.length === 0) return []

  const installments = await prisma.debtCardInstallment.findMany({ where: { id: { in: installmentIds } } })
  const ops: Prisma.PrismaPromise<unknown>[] = []
  const saldoDeltaByTarjeta = new Map<string, number>()
  let totalRefund = 0

  for (const inst of installments) {
    const total = Math.round(Number(inst.cuotaMensual) * inst.cuotasTotal * 100) / 100
    const abonado = Number(inst.montoAbonado)
    const pendiente = Math.max(0, Math.round((total - abonado) * 100) / 100)
    saldoDeltaByTarjeta.set(inst.tarjetaId, (saldoDeltaByTarjeta.get(inst.tarjetaId) ?? 0) + pendiente)
    totalRefund = Math.round((totalRefund + abonado) * 100) / 100
  }

  for (const [tarjetaId, monto] of saldoDeltaByTarjeta) {
    if (monto > 0) {
      ops.push(prisma.debt.update({
        where: { id: tarjetaId },
        data: { saldoRestante: { decrement: monto }, saldoPrincipal: { decrement: monto } },
      }))
    }
  }
  if (totalRefund > 0) {
    ops.push(prisma.user.update({ where: { id: userId }, data: planPocketCredit('obligaciones', totalRefund) }))
  }
  // Las asignaciones (DebtPaymentAllocation) se borran en cascada al borrar el
  // installment — no hace falta borrarlas aparte.
  ops.push(prisma.debtCardInstallment.deleteMany({ where: { id: { in: installmentIds } } }))

  return ops
}
