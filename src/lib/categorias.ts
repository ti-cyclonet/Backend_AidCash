/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Categorías de presupuesto: sugerencia automática
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Un gasto queda en una categoría por su FK (ImpulseExpense.budgetCategoryId).
 * Al registrarlo sin categoría explícita, Kiri propone una:
 *   1. Historial: si el usuario ya puso ese mismo consumo en una categoría
 *      ("InDriver" → Transporte), se reutiliza — Kiri "aprende" del usuario.
 *   2. Palabras clave de las categorías sugeridas (Transporte, Alimentación…).
 *   3. El nombre de la categoría aparece en la descripción.
 * La migración 20260928120000 aplicó estas mismas palabras clave (2 y 3) a los
 * gastos existentes que no traían etiqueta.
 */
import { prisma } from '../config/database.js'
import { nombreBaseGasto } from './hormiga.js'

export function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

/** Palabras clave por nombre (normalizado) de las categorías sugeridas. */
export const CATEGORIA_KEYWORDS: Record<string, string[]> = {
  vivienda: ['arriendo', 'renta', 'hipoteca', 'administracion', 'arreglo casa', 'muebles'],
  alimentacion: ['comida', 'mercado', 'supermercado', 'restaurante', 'hamburguesa', 'almuerzo', 'cena', 'cafeteria', 'snack', 'desayuno', 'pizza', 'pollo', 'arroz', 'domicilio', 'rappi', 'empanada', 'arepa', 'bunuelo', 'perrito'],
  transporte: ['gasolina', 'uber', 'indriver', 'didi', 'cabify', 'picap', 'taxi', 'bus', 'peaje', 'parqueadero', 'metro', 'transmilenio', 'moto', 'lavada', 'mantenimiento', 'aceite', 'llanta', 'pasaje'],
  servicios: ['internet', 'luz', 'agua', 'gas', 'telefono', 'celular', 'plan datos', 'streaming'],
  deudas: ['tarjeta', 'credito', 'prestamo', 'cuota', 'banco', 'interes'],
  ocio: ['netflix', 'spotify', 'cine', 'juego', 'bar', 'fiesta', 'salida', 'discoteca', 'cerveza', 'trago'],
  salud: ['medico', 'doctor', 'farmacia', 'odontologo', 'hospital', 'lentes', 'examen', 'cirugia', 'drogueria', 'cita medica'],
  familia: ['colegio', 'guarderia', 'juguete', 'mesada', 'hijos', 'papa', 'mama', 'regalo familia'],
  educacion: ['universidad', 'curso', 'libro', 'matricula', 'capacitacion', 'idiomas', 'diplomado'],
  ahorro: ['ahorro', 'inversion', 'fondo', 'emergencia'],
  mascotas: ['veterinario', 'perro', 'gato', 'mascota', 'peluqueria mascota', 'vacuna mascota'],
  compras: ['ropa', 'zapatos', 'accesorios', 'electronica', 'amazon', 'tienda', 'online'],
  deporte: ['gym', 'gimnasio', 'cancha', 'yoga', 'suplemento', 'proteina'],
  viajes: ['vuelo', 'hotel', 'vacaciones', 'paseo', 'hospedaje', 'maleta'],
}

function escaparRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Palabra completa (con plural opcional): "gas" no calza con "gasolina", "tintos" sí calza con "tinto". */
function contienePalabra(textoNormalizado: string, palabra: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escaparRegex(palabra)}s?([^a-z0-9]|$)`).test(textoNormalizado)
}

export type FuenteSugerencia = 'historial' | 'palabra_clave'

export interface SugerenciaCategoria {
  categoryId: string
  nombre: string
  fuente: FuenteSugerencia
}

export async function sugerirCategoria(userId: string, nombreGasto: string): Promise<SugerenciaCategoria | null> {
  const base = nombreBaseGasto(nombreGasto)
  if (!base) return null
  const categorias = await prisma.budgetCategory.findMany({ where: { userId }, select: { id: true, nombre: true } })
  if (categorias.length === 0) return null

  // 1. Historial: el mismo consumo ya categorizado antes por el usuario.
  // Se compara en memoria sin tildes ni mayúsculas ("Perritos de éxito" =
  // "perritos de exito"); un `contains` de SQL no ignora las tildes.
  const previos = await prisma.impulseExpense.findMany({
    where: { userId, budgetCategoryId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 300,
    select: { nombre: true, budgetCategoryId: true },
  })
  const baseNorm = normalizarTexto(base)
  const previo = previos.find(p => normalizarTexto(nombreBaseGasto(p.nombre)) === baseNorm)
  if (previo?.budgetCategoryId) {
    const cat = categorias.find(c => c.id === previo.budgetCategoryId)
    if (cat) return { categoryId: cat.id, nombre: cat.nombre, fuente: 'historial' }
  }

  // 2 y 3. Palabras clave de la categoría, o su propio nombre dentro de la descripción.
  for (const cat of categorias) {
    const catNorm = normalizarTexto(cat.nombre)
    const keywords = CATEGORIA_KEYWORDS[catNorm] ?? []
    if (keywords.some(k => contienePalabra(baseNorm, k)) || contienePalabra(baseNorm, catNorm)) {
      return { categoryId: cat.id, nombre: cat.nombre, fuente: 'palabra_clave' }
    }
  }
  return null
}

/**
 * Compatibilidad con clientes viejos (PWA en caché, cola offline) que todavía
 * mandan la categoría como etiqueta dentro del nombre: "[Cat] X" o "X [Cat]".
 * Devuelve el nombre sin la etiqueta y el id de la categoría si existe.
 */
export async function extraerEtiquetaCategoria(userId: string, nombre: string): Promise<{ nombre: string; categoryId: string | null }> {
  const m = nombre.match(/^\s*\[([^\]]+)\]\s*(.*)$/) ?? nombre.match(/^(.*?)\s*\[([^\]]+)\]\s*$/)
  if (!m) return { nombre, categoryId: null }
  const [etiqueta, resto] = nombre.trimStart().startsWith('[') ? [m[1], m[2]] : [m[2], m[1]]
  const categorias = await prisma.budgetCategory.findMany({ where: { userId }, select: { id: true, nombre: true } })
  const cat = categorias.find(c => normalizarTexto(c.nombre) === normalizarTexto(etiqueta))
  if (!cat || !resto.trim()) return { nombre, categoryId: null }
  return { nombre: resto.trim(), categoryId: cat.id }
}
