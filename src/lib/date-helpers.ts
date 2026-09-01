/**
 * Calcula a cuántos días de distancia está un día del mes (1-31) del día actual.
 * Maneja el cambio de mes (ej: hoy es 29, el día objetivo es el 1 → faltan pocos días,
 * no ~28).
 */
export function daysUntilDayOfMonth(today: number, target: number, daysInMonth: number): number {
  if (target >= today) return target - today
  return (daysInMonth - today) + target
}
