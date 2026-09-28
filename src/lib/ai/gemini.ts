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
 *   GEMINI_MODEL     (por defecto gemini-3.8-flash; si Google lo retira, se
 *                     reintenta solo con gemini-flash-latest)
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
// Google retira modelos (gemini-2.5-flash dejó de estar disponible para cuentas
// nuevas): si el modelo configurado ya no existe, se usa el alias "latest".
const MODELO_RESPALDO = 'gemini-flash-latest'
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
  let modeloActual = modelo()
  let saturadas = 0

  // Reintentos: si el modelo está saturado (503, pasa en picos de demanda) se
  // reintenta una vez y luego se pasa al modelo de respaldo; si el modelo fue
  // retirado (404), directo al respaldo.
  for (let intento = 0; intento < 4; intento++) {
    const url = `${base()}/v1beta/models/${modeloActual}:generateContent`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45000)
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave() }, body, signal: ctrl.signal })
    } catch (e) {
      clearTimeout(timer)
      throw new IAError('red', e instanceof Error ? e.message : 'fetch falló')
    }
    clearTimeout(timer)

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      if (res.status === 503) {
        saturadas++
        if (saturadas === 1) { await new Promise(r => setTimeout(r, 1500)); continue }
        if (modeloActual !== MODELO_RESPALDO) {
          console.warn(`[IA] ${modeloActual} saturado; probando ${MODELO_RESPALDO}`)
          modeloActual = MODELO_RESPALDO
          continue
        }
      }
      if (res.status === 404 && modeloActual !== MODELO_RESPALDO) {
        console.warn(`[IA] El modelo ${modeloActual} no está disponible; usando ${MODELO_RESPALDO}`)
        modeloActual = MODELO_RESPALDO
        continue
      }
      if (res.status === 429 || txt.includes('RESOURCE_EXHAUSTED')) throw new IAError('limite', txt.slice(0, 300))
      if (res.status === 503 || txt.includes('UNAVAILABLE')) throw new IAError('saturada', txt.slice(0, 300))
      if (txt.includes('API_KEY_INVALID') || txt.includes('API key not valid') || res.status === 401 || res.status === 403) throw new IAError('clave_invalida', txt.slice(0, 300))
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
  throw new IAError('saturada', 'sin respuesta tras reintentar')
}
