/**
 * Helpers de "¿cuándo vence esto?" compartidos entre el cron de notificaciones
 * (obligation-due-dates.ts, que solo avisa) y el cron de pago automático
 * (auto-pay.ts, que además cobra) — ambos deben coincidir exactamente en qué
 * día consideran "vence hoy"/"vencido", si no, uno podría notificar un día y
 * el otro cobrar otro.
 */
import type { Debt, DebtPayment, FixedExpense, FixedExpensePayment } from '@prisma/client'
import { getPeriodo, getMontoPorPeriodo } from './period.js'

export function parseDays(value: string | null | undefined): number[] {
  if (!value) return []
  return value.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d) && d >= 1 && d <= 31)
}

/** Día del mes de fechaCorte — acepta "15" o "2026-08-15". */
export function fixedExpenseDay(fechaCorte: string): number[] {
  if (!fechaCorte) return []
  if (fechaCorte.includes('-')) {
    const parts = fechaCorte.split('-')
    const day = parseInt(parts[parts.length - 1], 10)
    return isNaN(day) ? [] : [day]
  }
  return parseDays(fechaCorte)
}

/** Frontera Q1/Q2 de una obligación quincenal: sus PROPIOS días de cobro, no
 * los del sueldo del usuario dueño — dos deudas quincenales del mismo usuario
 * pueden cobrarse en días completamente distintos. */
export function itemPeriodo(frecuencia: string, ownDays: string): string {
  if (frecuencia !== 'quincenal') return getPeriodo(frecuencia)
  return getPeriodo('quincenal', parseDays(ownDays))
}

export function isDebtPending(debt: Debt, payments: DebtPayment[]): boolean {
  const periodo = itemPeriodo(debt.frecuenciaPago === 'quincenal' ? 'quincenal' : 'mensual', debt.diasPago)
  const paid = payments
    .filter(p => p.debtId === debt.id && p.periodo === periodo)
    .reduce((s, p) => s + Number(p.montoPagado), 0)
  return paid < Number(debt.cuotaPeriodo)
}

export function isFixedExpensePending(fe: FixedExpense, payments: FixedExpensePayment[]): boolean {
  const periodo = itemPeriodo(fe.frecuencia, fe.fechaCorte)
  const montoPorPeriodo = getMontoPorPeriodo(Number(fe.monto), fe.frecuencia)
  const paid = payments
    .filter(p => p.fixedExpenseId === fe.id && p.periodo === periodo)
    .reduce((s, p) => s + Number(p.montoPagado), 0)
  return paid < montoPorPeriodo
}

/** true si `today` es exactamente 1 día después de alguno de `days` (vencido ayer, o el fin de mes si `days` incluye el último día). */
export function isDayAfter(today: number, days: number[], daysInMonth: number): boolean {
  return days.some(d => (d === daysInMonth ? today === 1 : today === d + 1))
}
