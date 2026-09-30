/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cliente mínimo de Gemini (REST, salida JSON con esquema)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * La IA vivía en rutas de Next.js SIN autenticación (cualquiera con la URL
 * gastaba la cuota) y con la clave en el servidor del frontend. Ahora se llama
 * solo desde el backend, detrás del login.
 *
 * Variables de entorno:
 *   GEMINI_API_KEY   (también acepta GOOGLE_API_KEY o GOOGLE_GENAI_API_KEY)
 *   GEMINI_MODEL     (por defecto gemini-3.8-flash)
 *   GEMINI_FALLBACK_MODELS  modelos de respaldo, separados por coma (por
 *                     defecto gemini-3.5-flash,gemini-flash-lite-latest)
 *   GEMINI_API_BASE  (por defecto https://generativelanguage.googleapis.com — se
 *                     cambia en pruebas para apuntar a un servidor simulado)
 */

export type CodigoIA = 'no_configurada' | 'clave_invalida' | 'limite' | 'saturada' | 'respuesta_invalida' | 'red'

export class IAError extends Error {
  constructor(public codigo: CodigoIA, mensaje: string) { super(mensaje) }
}

/** Mensaje para el usuario según el tipo de falla. */
export const MENSAJE_IA: Record<CodigoIA, string> = {
  no_configurada: 'La IA de Kiri todavía no está activada. Mientras tanto puedes registrar todo desde los formularios de la app.',
  clave_invalida: 'La IA de Kiri todavía no está activada (la clave de Google AI no es válida). Mientras tanto puedes registrar todo desde los formularios de la app.',
  limite: 'Kiri Coach alcanzó su límite de uso por ahora. Intenta de nuevo más tarde.',
  saturada: 'El servicio de IA está con mucha demanda. Espera unos segundos e intenta de nuevo.',
  respuesta_invalida: 'No entendí bien la respuesta de la IA. Intenta de nuevo.',
  red: 'No pude conectarme con la IA. Revisa tu conexión e intenta de nuevo.',
}

const clave = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || ''
const modelo = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash'
// Modelos de respaldo, en orden. Si el principal está saturado (503), agotó su
// cuota (429, que en Google es por modelo) o fue retirado (404), se pasa al
// siguiente. Antes el único respaldo era gemini-flash-latest, que es un alias
// del mismo modelo principal y se satura con él: el escáner fallaba aunque
// gemini-3.5-flash y los "lite" respondían bien.
const RESPALDOS_POR_DEFECTO = ['gemini-3.5-flash', 'gemini-flash-lite-latest']
const cadenaModelos = (): string[] => {
  const extra = (process.env.GEMINI_FALLBACK_MODELS || '').split(',').map(m => m.trim()).filter(Boolean)
  return [...new Set([modelo(), ...(extra.length ? extra : RESPALDOS_POR_DEFECTO)])]
}
const base = () => (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')

export function iaConfigurada(): boolean {
  return clave().length > 0
}

export type ParteIA = { text: string } | { inlineData: { mimeType: string; data: string } }
export interface TurnoIA { role: 'user' | 'model'; parts: ParteIA[] }

export async function generarJSON<T>(opts: {
  sistema: string
  turnos: TurnoIA[]
  /** Esquema OpenAPI (subconjunto de Gemini: type en MAYÚSCULAS, enum, nullable, required) */
  esquema: Record<string, unknown>
  temperatura?: number
  timeoutMs?: number
}): Promise<T> {
  if (!iaConfigurada()) throw new IAError('no_configurada', 'Falta GEMINI_API_KEY')

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: opts.sistema }] },
    contents: opts.turnos,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: opts.esquema,
      temperature: opts.temperatura ?? 0.3,
    },
  })
  const modelos = cadenaModelos()
  const inicio = Date.now()
  const presupuestoMs = opts.timeoutMs ?? 45000
  let ultimo: IAError | null = null
  let huboLimite = false

  for (let i = 0; i < modelos.length; i++) {
    const modeloActual = modelos[i]
    const restante = presupuestoMs - (Date.now() - inicio)
    if (restante < 3000) break
    const url = `${base()}/v1beta/models/${modeloActual}:generateContent`
    const ctrl = new AbortController()
    // Cada intento deja tiempo para los respaldos (un modelo saturado a veces
    // no responde 503 sino que se queda colgado)
    const porIntento = i < modelos.length - 1 ? Math.min(restante, Math.max(15000, presupuestoMs * 0.45)) : restante
    const timer = setTimeout(() => ctrl.abort(), porIntento)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave() }, body, signal: ctrl.signal })
    } catch (e) {
      clearTimeout(timer)
      const abortado = e instanceof Error && e.name === 'AbortError'
      ultimo = new IAError(abortado ? 'saturada' : 'red', e instanceof Error ? e.message : 'fetch falló')
      if (abortado) { console.warn(`[IA] ${modeloActual} sin respuesta a tiempo; probando el siguiente modelo`); continue }
      throw ultimo
    }
    clearTimeout(timer)

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      if (txt.includes('API_KEY_INVALID') || txt.includes('API key not valid') || res.status === 401 || res.status === 403) throw new IAError('clave_invalida', txt.slice(0, 300))
      const limite = res.status === 429 || txt.includes('RESOURCE_EXHAUSTED')
      const saturada = res.status === 503 || res.status === 500 || txt.includes('UNAVAILABLE')
      if (limite || saturada || res.status === 404) {
        if (limite) huboLimite = true
        ultimo = new IAError(limite ? 'limite' : 'saturada', txt.slice(0, 300))
        console.warn(`[IA] ${modeloActual} respondió ${res.status}; probando el siguiente modelo`)
        continue
      }
      throw new IAError('red', `HTTP ${res.status}: ${txt.slice(0, 300)}`)
    }

    const data = await res.json().catch(() => null) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null
    const texto = data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
    const esObjeto = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
    try {
      const out = JSON.parse(texto)
      if (esObjeto(out)) return out as T
    } catch { /* abajo */ }
    // A veces llega envuelto en ```json … ```
    const m = texto.match(/\{[\s\S]*\}/)
    if (m) { try { const out = JSON.parse(m[0]); if (esObjeto(out)) return out as T } catch { /* abajo */ } }
    throw new IAError('respuesta_invalida', texto.slice(0, 300))
  }
  // Todos los modelos fallaron: si alguno fue por cuota, es un límite de uso
  if (huboLimite && ultimo?.codigo !== 'saturada') throw ultimo!
  throw ultimo ?? new IAError('saturada', 'sin respuesta tras probar todos los modelos')
}
