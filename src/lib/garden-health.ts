/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Salud del jardín (versión backend)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Puerto exacto de `getGardenHealth` en Frontend_AidCash/src/app/(dashboard)/
 * jardin/page.tsx. Se necesita acá para poder calcular la salud del jardín de
 * OTRO usuario (racha entre amigos / jardines vecinos) — el frontend solo
 * puede calcular la salud de la sesión actual, nunca la de un tercero.
 *
 * IMPORTANTE: si la fórmula cambia en el frontend, hay que replicar el cambio
 * acá a mano — son dos repos separados, no hay forma de compartir el código.
 */

import { prisma } from '../config/database.js'

function calculateHealth(
  streak: number,
  hasIncome: boolean,
  totalAhorrado: number,
  totalDeuda: number,
  hasObligations: boolean,
  hasBudgetCategories: boolean,
): number {
  let health = 15 // Base: el jardín siempre tiene algo de vida

  if (hasIncome) health += 15
  health += Math.min(streak * 5, 20)
  if (totalAhorrado > 0) health += 15

  if (totalDeuda <= 0) {
    health += 15
  } else if (streak > 0) {
    health += 5
  }

  if (hasBudgetCategories) health += 10
  if (hasObligations) health += 10

  return Math.max(0, Math.min(100, health))
}

/** Calcula la salud del jardín de un usuario a partir de sus datos reales. */
export async function getUserGardenHealth(userId: string): Promise<number> {
  const [user, debts, savingsSum, budgetCategoryCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { cashBalance: true, streakActual: true } }),
    prisma.debt.findMany({ where: { userId }, select: { saldoRestante: true, montoTotal: true } }),
    prisma.savingsHistory.aggregate({ where: { userId, tipo: 'ahorro' }, _sum: { monto: true } }),
    prisma.budgetCategory.count({ where: { userId } }),
  ])

  const totalAhorrado = Number(savingsSum._sum.monto ?? 0)
  const totalDeuda = debts.reduce((a, d) => a + Number(d.saldoRestante ?? d.montoTotal), 0)
  const hasIncome = Number(user?.cashBalance ?? 0) > 0
  const hasObligations = debts.length > 0
  const hasBudgetCategories = budgetCategoryCount > 0
  const streak = user?.streakActual ?? 0

  return calculateHealth(streak, hasIncome, totalAhorrado, totalDeuda, hasObligations, hasBudgetCategories)
}
