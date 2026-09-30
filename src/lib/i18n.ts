/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Idioma de los mensajes del backend (español / inglés)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Los mensajes se escriben en español en todo el backend. En vez de tocar
 * cientos de rutas, se traducen en los pocos puntos por donde salen:
 *   - las respuestas de la API (`error`, `message`): middleware `traducirRespuestas`
 *     según la cabecera `x-kiri-idioma` que manda la app;
 *   - avisos, push y notificaciones: `sendPushToUser` / `emitToUser`, según el
 *     idioma guardado en la cuenta (User.idioma).
 *
 * `traducir()` busca la frase exacta en el diccionario (lib/i18n-en.ts) y, si
 * no está, la reconoce como plantilla: "Llegaste a tus {0} {1} de {2}." con
 * sus valores, que también se traducen si son frases conocidas
 * ("categorías de presupuesto" → "budget categories"). Lo que no conoce lo deja
 * en español: nunca rompe un mensaje.
 */
import type { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database.js'
import { EN } from './i18n-en.js'

export type Idioma = 'es' | 'en'
export const normalizarIdioma = (v: unknown): Idioma => (typeof v === 'string' && v.toLowerCase().startsWith('en') ? 'en' : 'es')

// Plantillas del diccionario (las que tienen {0}, {1}…): texto fijo entre valores
const PLANTILLAS = Object.keys(EN)
  .filter(k => /\{\d+\}/.test(k))
  .map(k => {
    const orden: number[] = []
    const partes = k.split(/\{(\d+)\}/).filter((_, i) => { if (i % 2 === 1) return false; return true })
    k.replace(/\{(\d+)\}/g, (_, n) => { orden.push(Number(n)); return '' })
    return { clave: k, partes, orden, fijo: partes.join('').length }
  })
  // Primero las más específicas (más texto fijo)
  .sort((a, b) => b.fijo - a.fijo)

/**
 * Todas las formas de repartir `texto` en los valores de la plantilla. Con
 * varios valores hay más de una ("5 categorías de presupuesto de KIRI FREE":
 * ¿dónde termina cada valor?), así que se prueban todas (con un tope).
 */
function repartos(texto: string, partes: string[]): string[][] {
  const out: string[][] = []
  if (!texto.startsWith(partes[0])) return out
  const ir = (pos: number, i: number, acc: string[]) => {
    if (out.length >= 40) return
    const sig = partes[i + 1]
    if (i + 1 === partes.length - 1) {
      // Último valor: hasta el final, que debe terminar en el último texto fijo
      if (texto.endsWith(sig) && texto.length - sig.length >= pos) out.push([...acc, texto.slice(pos, texto.length - sig.length)])
      return
    }
    for (let j = texto.indexOf(sig, pos); j !== -1; j = texto.indexOf(sig, j + 1)) {
      ir(j + sig.length, i + 1, [...acc, texto.slice(pos, j)])
      if (!sig) break
    }
  }
  ir(partes[0].length, 0, [])
  return out
}

/** Qué tan creíble es un valor: números y frases conocidas suman; español suelto resta. */
function puntaje(v: string, profundidad: number): number {
  const x = v.trim()
  if (!x) return 0
  if (/^[-+$\d.,%\s]+$/.test(x)) return 2
  if (traducirFrase(x, profundidad + 1) !== null) return 3
  if (/[áéíóúñ]|\b(de|la|el|en|y|con|por|para|tu|tus)\b/i.test(x)) return -1 - (x.split(/\s+/).length > 3 ? 1 : 0)
  return 0
}

function traducirFrase(texto: string, profundidad: number): string | null {
  if (EN[texto] !== undefined) return EN[texto]
  if (profundidad > 3) return null
  for (const p of PLANTILLAS) {
    if (!texto.startsWith(p.partes[0]) || !texto.endsWith(p.partes[p.partes.length - 1])) continue
    const opciones = repartos(texto, p.partes)
    if (!opciones.length) continue
    const mejor = opciones.length === 1 ? opciones[0]
      : opciones.map(o => ({ o, s: o.reduce((a, v) => a + puntaje(v, profundidad), 0) })).sort((a, b) => b.s - a.s)[0].o
    const valores: Record<number, string> = {}
    p.orden.forEach((n, i) => { valores[n] = mejor[i] })
    return EN[p.clave].replace(/\{(\d+)\}/g, (_, n) => traducirTexto(valores[Number(n)] ?? '', profundidad + 1))
  }
  return null
}

/** Traduce conservando los espacios de los bordes; si no la conoce, prueba oración por oración. */
function traducirTexto(texto: string, profundidad = 0): string {
  if (!texto || !/[a-záéíóúñ]/i.test(texto)) return texto
  const ini = texto.match(/^\s*/)![0], fin = texto.match(/\s*$/)![0]
  const nucleo = texto.slice(ini.length, texto.length - fin.length)
  const t = traducirFrase(nucleo, profundidad)
  if (t !== null) return ini + t + fin
  const oraciones = nucleo.split(/(?<=[.!?])\s+/)
  if (oraciones.length > 1) return ini + oraciones.map(o => traducirFrase(o, profundidad) ?? o).join(' ') + fin
  return texto
}

export function traducir(texto: string, idioma: Idioma): string
export function traducir(texto: string | null | undefined, idioma: Idioma): string | null | undefined
export function traducir(texto: string | null | undefined, idioma: Idioma) {
  if (idioma !== 'en' || typeof texto !== 'string') return texto
  return traducirTexto(texto)
}

/** Traduce los campos de texto de un objeto de aviso/notificación (sin tocar ids, rutas ni montos). */
const CAMPOS = new Set(['title', 'body', 'message', 'mensaje', 'detalle', 'error', 'descripcion', 'titulo'])
export function traducirCampos<T>(data: T, idioma: Idioma): T {
  if (idioma !== 'en' || !data || typeof data !== 'object' || Array.isArray(data)) return data
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  for (const k of Object.keys(out)) {
    if (CAMPOS.has(k) && typeof out[k] === 'string') out[k] = traducir(out[k] as string, idioma)
    if (k === 'actions' && Array.isArray(out[k])) out[k] = (out[k] as { title?: string }[]).map(a => ({ ...a, title: a.title ? traducir(a.title, idioma) : a.title }))
  }
  return out as T
}

// ─── Idioma de cada usuario (con caché corta) ────────────────────────────────

const cache = new Map<string, { v: Idioma; hasta: number }>()
export async function idiomaDe(userId: string): Promise<Idioma> {
  const c = cache.get(userId)
  if (c && c.hasta > Date.now()) return c.v
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { idioma: true } }).catch(() => null)
  const v = normalizarIdioma(u?.idioma)
  cache.set(userId, { v, hasta: Date.now() + 5 * 60 * 1000 })
  return v
}
export function olvidarIdioma(userId: string) { cache.delete(userId) }

/** Idioma de la petición: cabecera de la app, o el de la cuenta. */
export function idiomaDePeticion(req: Request): Idioma {
  return normalizarIdioma(req.headers['x-kiri-idioma'] ?? '')
}

/**
 * Middleware: traduce `error` y `message` de las respuestas JSON cuando la app
 * pide inglés (cabecera `x-kiri-idioma: en`). Los códigos (LIMIT_REACHED…) no
 * se tocan porque no están en el diccionario.
 */
export function traducirRespuestas(req: Request, res: Response, next: NextFunction) {
  const idioma = idiomaDePeticion(req)
  if (idioma === 'en') {
    const json = res.json.bind(res)
    res.json = (body: unknown) => {
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const b = { ...(body as Record<string, unknown>) }
        for (const k of ['error', 'message']) if (typeof b[k] === 'string') b[k] = traducir(b[k] as string, 'en')
        return json(b)
      }
      return json(body)
    }
  }
  next()
}
