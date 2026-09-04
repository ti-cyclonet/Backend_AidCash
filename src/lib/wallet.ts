import type { Prisma } from '@prisma/client'

export const WALLET_POCKET_FIELD = {
  ahorro: 'walletAhorro',
  obligaciones: 'walletObligaciones',
  libre: 'walletLibre',
  endeudamiento: 'walletEndeudamiento',
} as const

export type WalletPocket = keyof typeof WALLET_POCKET_FIELD

/**
 * Construye el `data` de un `prisma.user.update` que descuenta cashBalance y
 * un bolsillo específico por EL MISMO monto — nunca por dos topes distintos.
 * Esa divergencia (cada campo topado contra un valor "actual" diferente) es
 * la causa raíz de que cashBalance deje de ser igual a la suma de bolsillos
 * (ver auditoría QA, patrón sistémico 02: GES-02 / SOC-01 / AHO-04).
 *
 * El monto se descuenta completo de ambos campos, sin topar por el bolsillo:
 * el bolsillo es solo un desglose notional de cashBalance, nunca el límite
 * real de cuánto se puede gastar — ese límite es cashBalance, y quien llama
 * esta función ya debe haberlo validado antes (por eso no vuelve a topar
 * aquí; toparlo por el bolsillo fue justamente el bug original de GES-02:
 * una vez el bolsillo notional quedaba en 0 o negativo por otra operación,
 * bloqueaba en silencio descuentos legítimos que sí tenían saldo real detrás).
 * El bolsillo puede quedar en negativo — la capa de presentación ya trunca
 * los bolsillos a 0 al mostrarlos.
 */
export function planPocketDeduction(pocket: WalletPocket, monto: number): Prisma.UserUpdateInput {
  const field = WALLET_POCKET_FIELD[pocket]
  return {
    cashBalance: { decrement: monto },
    [field]: { decrement: monto },
  } as Prisma.UserUpdateInput
}

/**
 * El espejo de `planPocketDeduction`: dinero que VUELVE a estar disponible
 * (retirar de un bolsillo de ahorro, de un fondo de emergencia, etc.) —
 * cashBalance y el bolsillo suben por el mismo monto. No hace falta topar
 * nada: acreditar de más nunca rompe el invariante, solo lo restaura.
 */
export function planPocketCredit(pocket: WalletPocket, monto: number): Prisma.UserUpdateInput {
  const field = WALLET_POCKET_FIELD[pocket]
  return {
    cashBalance: { increment: monto },
    [field]: { increment: monto },
  } as Prisma.UserUpdateInput
}
