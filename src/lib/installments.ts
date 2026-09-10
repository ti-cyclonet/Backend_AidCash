import { prisma } from '../config/database.js'
import { planPocketCredit } from './wallet.js'
import type { Prisma } from '@prisma/client'

/**
 * Cuota efectiva de una tarjeta: la cuota base más los planes de cuotas de
 * pay-with-card que TODAVÍA no se han pagado por completo. Antes un plan
 * dejaba de sumar por tiempo transcurrido (createdAt + cuotasTotal meses),
 * sin importar si de verdad se había pagado — el saldo real seguía debiéndose
 * pero la cuota sugerida lo "olvidaba" en silencio. Ahora solo deja de sumar
 * cuando montoAbonado alcanza el total del plan.
 */
export function cuotaEfectivaTarjeta(
  cuotaBase: number,
  installments: { cuotaMensual: Prisma.Decimal | number; cuotasTotal: number; montoAbonado: Prisma.Decimal | number }[],
): number {
  const activos = installments.filter(p => Number(p.montoAbonado) < Number(p.cuotaMensual) * p.cuotasTotal)
  const sumaActivos = activos.reduce((s, p) => s + Number(p.cuotaMensual), 0)
  return Math.round((cuotaBase + sumaActivos) * 100) / 100
}

/**
 * Reparte el abono a capital de un pago sobre la propia tarjeta entre sus
 * planes de cuotas vigentes — el más antiguo primero — hasta agotar el pago o
 * los planes. Cada porción queda registrada en DebtPaymentAllocation para que
 * undo-pay pueda revertirla con precisión más adelante. Lo que sobra después
 * de cubrir todos los planes reduce el saldo "base" de la tarjeta sin más
 * (ya lo hace el UPDATE de saldoRestante de quien llama esta función).
 *
 * Debe llamarse ANTES del $transaction que crea el DebtPayment, pasándole el
 * id ya generado (randomUUID) para poder enlazar las asignaciones — mismo
 * patrón que ya usa pay-with-card con el id del installment.
 */
export async function allocateCardPayment(
  tarjetaId: string,
  debtPaymentId: string,
  abonoCapital: number,
): Promise<Prisma.PrismaPromise<unknown>[]> {
  if (abonoCapital <= 0) return []

  const installments = await prisma.debtCardInstallment.findMany({
    where: { tarjetaId },
    orderBy: { createdAt: 'asc' },
  })

  const ops: Prisma.PrismaPromise<unknown>[] = []
  let capitalLeft = abonoCapital
  for (const inst of installments) {
    if (capitalLeft <= 0) break
    const total = Number(inst.cuotaMensual) * inst.cuotasTotal
    const remaining = Math.round((total - Number(inst.montoAbonado)) * 100) / 100
    if (remaining <= 0) continue
    const applied = Math.round(Math.min(remaining, capitalLeft) * 100) / 100
    ops.push(prisma.debtPaymentAllocation.create({ data: { debtPaymentId, installmentId: inst.id, monto: applied } }))
    ops.push(prisma.debtCardInstallment.update({ where: { id: inst.id }, data: { montoAbonado: { increment: applied } } }))
    capitalLeft = Math.round((capitalLeft - applied) * 100) / 100
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
