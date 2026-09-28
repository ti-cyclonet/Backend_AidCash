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

type SaldosBolsillos = Record<WalletPocket, number>

/**
 * Descuenta `monto` de cashBalance tomando de los bolsillos en ORDEN: primero
 * lo que tengan disponible (positivo) `orden[0]`, luego `orden[1]`… y si aun
 * así falta (bolsillos descuadrados), el resto sale del último. Así un gasto
 * que el usuario decidió hacer "con lo que tenga" (ej. prestar plata con el
 * gasto libre en $0) no deja el bolsillo libre en negativo mientras otro
 * bolsillo sí tenía la plata. Devuelve el `data` del update y el desglose.
 */
export function planDeduccionEnCascada(
  saldos: SaldosBolsillos,
  monto: number,
  orden: WalletPocket[] = ['libre', 'endeudamiento', 'ahorro', 'obligaciones'],
): { data: Prisma.UserUpdateInput; desglose: Partial<Record<WalletPocket, number>> } {
  const desglose: Partial<Record<WalletPocket, number>> = {}
  let falta = Math.round(monto * 100) / 100
  for (const pocket of orden) {
    if (falta <= 0) break
    const tomar = Math.min(falta, Math.max(0, saldos[pocket]))
    if (tomar > 0) {
      desglose[pocket] = Math.round(tomar * 100) / 100
      falta = Math.round((falta - tomar) * 100) / 100
    }
  }
  if (falta > 0) {
    const ultimo = orden[orden.length - 1]
    desglose[ultimo] = Math.round(((desglose[ultimo] ?? 0) + falta) * 100) / 100
  }
  const data: Record<string, unknown> = { cashBalance: { decrement: monto } }
  for (const [pocket, valor] of Object.entries(desglose)) {
    data[WALLET_POCKET_FIELD[pocket as WalletPocket]] = { decrement: valor }
  }
  return { data: data as Prisma.UserUpdateInput, desglose }
}
