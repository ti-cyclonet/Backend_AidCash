/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cómo recibe su plata cada usuario
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tres casos reales:
 *   1. Sueldo fijo igual: mensual, o quincenal con las dos quincenas iguales
 *      (cada quincena = ingresoBase / 2).
 *   2. Sueldo fijo que cambia por quincena: ej. $1.000.000 la 1.ª y $750.000
 *      la 2.ª (ingresoQuincena1 / ingresoQuincena2; ingresoBase = la suma).
 *   3. Ingresos variables (independiente, ventas, comisiones): no hay sueldo
 *      fijo. ingresoBase es lo que ESTIMA que le entra al mes (0 si no sabe);
 *      sin estimación, Kiri planea con su promedio real de los últimos meses.
 *
 * ingresoBase siempre es MENSUAL.
 */
import { prisma } from '../config/database.js'

export type TipoIngreso = 'fijo' | 'variable'

export interface PerfilIngreso {
  tipoIngreso: string
  frecuenciaIngreso: string
  ingresoBase: unknown
  ingresoQuincena1?: unknown
  ingresoQuincena2?: unknown
}

const n = (v: unknown) => Number(v ?? 0) || 0

/**
 * Promedio mensual de lo que el usuario REGISTRÓ como ingreso: los últimos 3
 * meses completos (desde el primer mes con registros). Si todavía no tiene un
 * mes completo, lo que lleva en el mes en curso.
 */
export async function ingresoPromedioMensual(userId: string, now: Date = new Date()): Promise<number> {
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1)
  const hace3 = new Date(now.getFullYear(), now.getMonth() - 3, 1)
  const registros = await prisma.incomeRecord.findMany({
    where: { userId, createdAt: { gte: hace3 } },
    select: { monto: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const completos = registros.filter(r => r.createdAt < inicioMes)
  if (completos.length > 0) {
    const primero = completos[0].createdAt
    const meses = (inicioMes.getFullYear() - primero.getFullYear()) * 12 + (inicioMes.getMonth() - primero.getMonth())
    const total = completos.reduce((s, r) => s + Number(r.monto), 0)
    return Math.round(total / Math.max(1, meses))
  }
  return Math.round(registros.reduce((s, r) => s + Number(r.monto), 0))
}

/** Ingreso MENSUAL con el que Kiri planea (variable sin estimación → su promedio). */
export function ingresoReferenciaMensual(p: PerfilIngreso, promedio = 0): number {
  if (p.tipoIngreso === 'variable') return n(p.ingresoBase) > 0 ? n(p.ingresoBase) : promedio
  const q1 = n(p.ingresoQuincena1), q2 = n(p.ingresoQuincena2)
  if (p.frecuenciaIngreso === 'quincenal' && q1 > 0 && q2 > 0) return q1 + q2
  return n(p.ingresoBase)
}

/** Lo que recibe en la 1.ª o 2.ª quincena (o el mes completo si es mensual o variable). */
export function ingresoDeQuincena(p: PerfilIngreso, quincena: 1 | 2, promedio = 0): number {
  if (p.tipoIngreso === 'variable' || p.frecuenciaIngreso !== 'quincenal') return ingresoReferenciaMensual(p, promedio)
  const q1 = n(p.ingresoQuincena1), q2 = n(p.ingresoQuincena2)
  if (q1 > 0 && q2 > 0) return quincena === 1 ? q1 : q2
  return Math.round(n(p.ingresoBase) / 2)
}

/** Montos que se consideran "su sueldo" al clasificar un ingreso (salario vs extra). */
export function montosDeSueldo(p: PerfilIngreso, promedio = 0): number[] {
  if (p.tipoIngreso === 'variable') return []
  if (p.frecuenciaIngreso === 'quincenal') return [...new Set([ingresoDeQuincena(p, 1), ingresoDeQuincena(p, 2)])].filter(v => v > 0)
  const m = ingresoReferenciaMensual(p, promedio)
  return m > 0 ? [m] : []
}

/** Texto corto para el coach: cómo recibe la plata este usuario. */
export function describirIngreso(p: PerfilIngreso, promedio = 0): string {
  const $ = (v: number) => `$${Math.round(v).toLocaleString('es-CO')}`
  if (p.tipoIngreso === 'variable') {
    return n(p.ingresoBase) > 0
      ? `ingresos variables (sin sueldo fijo), estima unos ${$(n(p.ingresoBase))} al mes; promedio real registrado ${$(promedio)} al mes`
      : `ingresos variables (sin sueldo fijo), promedio real registrado ${$(promedio)} al mes`
  }
  if (p.frecuenciaIngreso === 'quincenal') {
    const q1 = ingresoDeQuincena(p, 1), q2 = ingresoDeQuincena(p, 2)
    return q1 !== q2
      ? `sueldo fijo quincenal que cambia: ${$(q1)} la 1.ª quincena y ${$(q2)} la 2.ª (${$(q1 + q2)} al mes)`
      : `sueldo fijo quincenal de ${$(q1)} por quincena (${$(q1 + q2)} al mes)`
  }
  return `sueldo fijo mensual de ${$(n(p.ingresoBase))}`
}

// ─── Nombre en partes ────────────────────────────────────────────────────────

export interface PartesNombre { primerNombre: string; segundoNombre: string; primerApellido: string; segundoApellido: string }

/** Une las partes en el `nombre` completo que se muestra en toda la app. */
export function unirNombre(p: Partial<PartesNombre>): string {
  return [p.primerNombre, p.segundoNombre, p.primerApellido, p.segundoApellido].map(x => (x ?? '').trim()).filter(Boolean).join(' ')
}

/**
 * Solo para cuentas viejas sin partes guardadas: la mejor suposición a partir
 * del nombre completo (4 palabras = 2 nombres + 2 apellidos; 3 = 1 nombre + 2
 * apellidos, lo más común en Colombia; 2 = nombre + apellido).
 */
export function partirNombre(nombre: string): PartesNombre {
  const w = nombre.trim().split(/\s+/).filter(Boolean)
  if (w.length >= 4) return { primerNombre: w[0], segundoNombre: w.slice(1, w.length - 2).join(' '), primerApellido: w[w.length - 2], segundoApellido: w[w.length - 1] }
  if (w.length === 3) return { primerNombre: w[0], segundoNombre: '', primerApellido: w[1], segundoApellido: w[2] }
  return { primerNombre: w[0] ?? '', segundoNombre: '', primerApellido: w[1] ?? '', segundoApellido: '' }
}
