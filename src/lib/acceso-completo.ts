/**
 * Cuentas con acceso completo a todos los módulos sin contrato en Authoriza
 * (QA y el dueño de la app). Las usan GET /plan (qué módulos se ven) y
 * checkLimit (cuántos registros se pueden crear) — antes la lista vivía solo
 * en plan.routes.ts, así que una cuenta podía ver un módulo premium pero
 * chocar con el límite de creación del plan gratis.
 *
 * Ojo: esto también aplica en producción. Quitar los correos de QA cuando ya
 * no se necesiten.
 */
export const CORREOS_ACCESO_COMPLETO: readonly string[] = [
  'test@kiri.app',
  'qa.obligaciones@kiri.test',
  'qa.me@kiri.test',
  'qa.partner@kiri.test',
  'alfredoj.mambyj@outlook.com',
]

export function tieneAccesoCompleto(correo: string | null | undefined): boolean {
  return !!correo && CORREOS_ACCESO_COMPLETO.includes(correo.trim().toLowerCase())
}
