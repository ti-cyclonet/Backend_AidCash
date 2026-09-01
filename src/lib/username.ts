/**
 * Kiri Finance — Username autogenerado
 *
 * El @username es público (se usa para buscar gente en Social) pero nunca es
 * un paso nuevo de onboarding: se genera solo del `nombre` al registrarse, y
 * queda editable después desde Perfil.
 */

import { prisma } from '../config/database.js'

/** "Juan Pérez" → "juanperez" — minúsculas, sin tildes/espacios/símbolos. */
export function slugify(nombre: string): string {
  const base = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quitar tildes
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 15)
  return base.length >= 3 ? base : (base + 'usuario').slice(0, 15)
}

/**
 * Genera un @username único a partir del nombre: prueba "juanperez",
 * "juanperez2", "juanperez3"... hasta encontrar uno libre.
 */
export async function generateUniqueUsername(nombre: string): Promise<string> {
  const base = slugify(nombre)
  let candidate = base
  let suffix = 1

  while (true) {
    const existing = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })
    if (!existing) return candidate
    suffix += 1
    candidate = `${base}${suffix}`.slice(0, 20)
  }
}
