/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Pago automático en la fecha de vencimiento
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Antes, "pago automático" (⚡) solo se ejecutaba como efecto secundario de
 * registrar el sueldo en Billetera (ver executeAutoPays en BilleteraTab.tsx) —
 * si el día de vencimiento llegaba y el usuario no registraba su sueldo justo
 * ESE día, la obligación se quedaba sin cobrar pese al ⚡, sin ningún aviso.
 * Esto corre una vez al día (ver cron/auto-pay.ts) y cobra lo que de verdad
 * vence HOY, sin depender de que el usuario haga nada — el usuario le puso el
 * rayo justamente para no tener que acordarse.
 *
 * Usa exactamente las mismas funciones de pago que la ruta HTTP manual
 * (payDebtServer / payFixedExpenseServer) para que un cobro automático calce
 * en centavos con uno manual — nunca dos implementaciones separadas del mismo
 * cálculo de interés/asignación a tarjeta.
 *
 * Reglas de origen del dinero (sin usuario presente para elegir, a diferencia
 * del flujo manual "Saldo insuficiente"):
 *  - Gasto fijo con tarjeta vinculada (tarjetaVinculadaId): siempre se cobra a
 *    esa tarjeta — es exactamente para lo que existe el vínculo.
 *  - Cualquier otro caso (deudas, gastos fijos sin tarjeta vinculada): solo se
 *    cobra si el `cashBalance` alcanza. Si no alcanza, NO se fuerza un saldo
 *    negativo ni se elige una tarjeta por el usuario sin que él lo haya
 *    configurado — se deja pendiente y se avisa por push para que decida a mano.
 */
import { prisma } from '../config/database.js'
import { getMontoPorPeriodo } from './period.js'
import { parseDays, fixedExpenseDay, isDebtPending, isFixedExpensePending } from './obligation-schedule.js'
import { cuotaEfectivaTarjeta } from './installments.js'
import { payDebtServer } from './debt-payments.js'
import { payFixedExpenseServer } from './fixed-expense-payments.js'
import { sendPushToUser } from './push.js'
import type { Debt, FixedExpense } from '@prisma/client'

export interface AutoPayRunSummary {
  debtsPaid: number
  fixedExpensesPaid: number
  skippedInsufficientFunds: number
  errors: number
}

/** true si HOY es exactamente uno de `days` (el día de vencimiento en sí). */
function isDueToday(today: number, days: number[]): boolean {
  return days.includes(today)
}

async function notifyAutoPaySkipped(userId: string, nombre: string, monto: number) {
  await sendPushToUser(userId, {
    title: '⚠️ No se pudo cobrar automáticamente',
    body: `"${nombre}" vence hoy ($${monto.toLocaleString('es-CO')}) pero tu disponible no alcanza. Págala a mano cuando puedas.`,
    tag: 'auto-pay-skipped',
    url: '/obligaciones',
  }).catch(() => {})
}

/**
 * Corre una vez al día (cron/auto-pay.ts la programa antes del cron de
 * notificaciones de vencimiento, para que algo que se acaba de cobrar solo no
 * dispare además un aviso de "vencido"). Revisa TODAS las deudas y gastos
 * fijos de TODOS los usuarios con pago automático activo — mismo patrón
 * "sin cron por usuario" que ya usa obligation-due-dates.ts.
 */
export async function runAutoPay(now: Date = new Date()): Promise<AutoPayRunSummary> {
  const today = now.getDate()
  const summary: AutoPayRunSummary = { debtsPaid: 0, fixedExpensesPaid: 0, skippedInsufficientFunds: 0, errors: 0 }

  const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)

  const [autoDebts, autoFixed] = await Promise.all([
    prisma.debt.findMany({ where: { estado: 'activa', pagoAutomatico: true } }),
    prisma.fixedExpense.findMany({ where: { pagoAutomatico: true } }),
  ])

  const [debtPayments, fixedPayments] = await Promise.all([
    autoDebts.length > 0
      ? prisma.debtPayment.findMany({ where: { debtId: { in: autoDebts.map((d: Debt) => d.id) }, createdAt: { gte: fortyDaysAgo } } })
      : Promise.resolve([]),
    autoFixed.length > 0
      ? prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: { in: autoFixed.map((f: FixedExpense) => f.id) }, createdAt: { gte: fortyDaysAgo } } })
      : Promise.resolve([]),
  ])

  // ─── Deudas ───────────────────────────────────────────────────────────────
  for (const debt of autoDebts) {
    try {
      if (!isDebtPending(debt, debtPayments)) continue
      const days = parseDays(debt.diasPago)
      if (days.length === 0 || !isDueToday(today, days)) continue

      // Para tarjetas, el monto real de esta cuota incluye lo financiado con
      // ella (pay-with-card) — no solo la columna base (ver cuotaEfectivaTarjeta).
      const montoPago = debt.tipoDeuda === 'TARJETA_CREDITO'
        ? cuotaEfectivaTarjeta(Number(debt.cuotaPeriodo), await prisma.debtCardInstallment.findMany({ where: { tarjetaId: debt.id } }))
        : Number(debt.cuotaPeriodo)

      const user = await prisma.user.findUnique({ where: { id: debt.userId }, select: { cashBalance: true } })
      if (!user || Number(user.cashBalance) < montoPago) {
        await notifyAutoPaySkipped(debt.userId, debt.nombre, montoPago)
        summary.skippedInsufficientFunds++
        continue
      }

      await payDebtServer(debt.userId, debt.id)
      summary.debtsPaid++
      console.log(`[AutoPago] Deuda "${debt.nombre}" cobrada automáticamente al vencer`)
    } catch (err) {
      summary.errors++
      console.error(`[AutoPago] Error cobrando deuda "${debt.nombre}":`, err)
    }
  }

  // ─── Gastos fijos ─────────────────────────────────────────────────────────
  for (const fe of autoFixed) {
    try {
      if (!isFixedExpensePending(fe, fixedPayments)) continue
      const days = fixedExpenseDay(fe.fechaCorte)
      if (days.length === 0 || !isDueToday(today, days)) continue

      // Con tarjeta vinculada, la tarjeta absorbe el pago — no depende de
      // cuánto efectivo tenga el usuario, así que se cobra siempre.
      if (!fe.tarjetaVinculadaId) {
        const montoPago = getMontoPorPeriodo(Number(fe.monto), fe.frecuencia)
        const user = await prisma.user.findUnique({ where: { id: fe.userId }, select: { cashBalance: true } })
        if (!user || Number(user.cashBalance) < montoPago) {
          await notifyAutoPaySkipped(fe.userId, fe.nombre, montoPago)
          summary.skippedInsufficientFunds++
          continue
        }
      }

      await payFixedExpenseServer(fe.userId, fe.id)
      summary.fixedExpensesPaid++
      console.log(`[AutoPago] Gasto fijo "${fe.nombre}" cobrado automáticamente al vencer`)
    } catch (err) {
      summary.errors++
      console.error(`[AutoPago] Error cobrando gasto fijo "${fe.nombre}":`, err)
    }
  }

  return summary
}
