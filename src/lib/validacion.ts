import { z } from 'zod'

/**
 * Validaciones compartidas de las rutas. Antes cada esquema aceptaba cualquier
 * texto o número: un nombre de 200.000 letras, uno hecho solo de espacios, el
 * día de pago "45" o "abc", o montos que no caben en la columna (Decimal(12,2),
 * hasta 10^10) y reventaban con un 500 genérico.
 */

/** Tope de cualquier número del cuerpo de una petición (ver middleware validate). */
export const MONTO_MAXIMO = 5_000_000_000

/** Nombre de un movimiento/obligación: sin espacios sueltos y de largo razonable. */
export const nombreRequerido = z.string().trim().min(1, 'El nombre es requerido').max(120, 'El nombre es muy largo (máximo 120 caracteres)')

/** Días del mes en que se paga: "15" o, en quincenal, "15,30" (cada uno de 1 a 31). */
export const diasDelMes = z.string().trim().refine(
  v => /^\d{1,2}(\s*,\s*\d{1,2})?$/.test(v) && v.split(',').every(d => { const n = Number(d.trim()); return n >= 1 && n <= 31 }),
  'El día de pago debe ser un número del 1 al 31 (o dos, separados por coma)',
)

/**
 * Día de corte de un gasto fijo: como `diasDelMes`, o una fecha "2026-10-15"
 * (así lo mandaban las acciones de Kiri Coach; ver fixedExpenseDay).
 */
export const fechaDeCorte = z.string().trim().refine(
  v => diasDelMes.safeParse(v).success || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00`).getTime()) && Number(v.slice(8)) >= 1 && Number(v.slice(8)) <= 31),
  'El día de pago debe ser un número del 1 al 31 (o dos, separados por coma)',
)

/** Número de la petición fuera de rango (o no finito) en cualquier nivel del cuerpo. */
export function numeroFueraDeRango(valor: unknown, profundidad = 0): boolean {
  if (profundidad > 6 || valor === null || valor === undefined) return false
  if (typeof valor === 'number') return !Number.isFinite(valor) || Math.abs(valor) > MONTO_MAXIMO
  if (Array.isArray(valor)) return valor.some(v => numeroFueraDeRango(v, profundidad + 1))
  if (typeof valor === 'object') return Object.values(valor as Record<string, unknown>).some(v => numeroFueraDeRango(v, profundidad + 1))
  return false
}
