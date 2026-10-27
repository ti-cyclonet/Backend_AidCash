/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cliente mínimo de Gemini (REST, salida JSON con esquema)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * La IA vivía en rutas de Next.js SIN autenticación (cualquiera con la URL
 * gastaba la cuota) y con la clave en el servidor del frontend. Ahora se llama
 * solo desde el backend, detrás del login.
 *
 * Velocidad (oct-2026): con el prompt real del coach (~9.400 tokens) los modelos
 * "lite" responden en ~2 s y gemini-3.5-flash en ~5-6 s; gemini-3.8-flash y
 * 3.7-flash pasaban horas del día en 503 o colgados, y cada pedido esperaba
 * ~20 s antes de probar el respaldo (respuestas de 25-50 s). Ahora:
 *   - la cadena empieza por un modelo rápido;
 *   - se pide poco razonamiento (thinkingLevel "low"), que es lo que más tarda;
 *   - si el modelo en curso no contesta en unos segundos, se lanza el siguiente
 *     EN PARALELO y gana el primero que responda bien (los demás se cancelan).
 *
 * Variables de entorno:
 *   GEMINI_API_KEY   (también acepta GOOGLE_API_KEY o GOOGLE_GENAI_API_KEY)
 *   GEMINI_MODEL     modelo principal (por defecto gemini-3.5-flash-lite)
 *   GEMINI_FALLBACK_MODELS  modelos de respaldo, separados por coma
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

/**
 * "rapido": chat y dictado (texto corto, se nota cada segundo de espera).
 * "preciso": recibos (leer una foto pide más modelo; el usuario espera un escaneo).
 */
export type ModoIA = 'rapido' | 'preciso'
const CADENAS: Record<ModoIA, string[]> = {
  rapido: ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'],
  preciso: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'],
}
/** Cuánto se espera al modelo en curso antes de lanzar el siguiente en paralelo. */
const ESPERA_RESPALDO_MS: Record<ModoIA, number> = { rapido: 4500, preciso: 9000 }

const cadenaModelos = (modo: ModoIA): string[] => {
  const extra = (process.env.GEMINI_FALLBACK_MODELS || '').split(',').map(m => m.trim()).filter(Boolean)
  const principal = process.env.GEMINI_MODEL?.trim()
  const base = extra.length ? extra : CADENAS[modo]
  return [...new Set([...(principal ? [principal] : []), ...base])]
}
const base = () => (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')

/** Modelos que rechazaron thinkingConfig (400): se les vuelve a pedir sin él. */
const sinPensar = new Set<string>()

export function iaConfigurada(): boolean {
  return clave().length > 0
}

export type ParteIA = { text: string } | { inlineData: { mimeType: string; data: string } }
export interface TurnoIA { role: 'user' | 'model'; parts: ParteIA[] }

/** Un intento contra un modelo. Lanza IAError con el tipo de falla. */
async function intento<T>(modelo: string, cuerpo: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  const conPensar = !sinPensar.has(modelo)
  const generationConfig = { ...(cuerpo.generationConfig as Record<string, unknown>), ...(conPensar ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) }
  let res: Response
  try {
    res = await fetch(`${base()}/v1beta/models/${modelo}:generateContent`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave() },
      body: JSON.stringify({ ...cuerpo, generationConfig }),
    })
  } catch (e) {
    const abortado = e instanceof Error && e.name === 'AbortError'
    throw new IAError(abortado ? 'saturada' : 'red', e instanceof Error ? e.message : 'fetch falló')
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    if (txt.includes('API_KEY_INVALID') || txt.includes('API key not valid') || res.status === 401 || res.status === 403) throw new IAError('clave_invalida', txt.slice(0, 300))
    if (res.status === 400 && conPensar && /thinking/i.test(txt)) {
      sinPensar.add(modelo)
      return intento<T>(modelo, cuerpo, signal)
    }
    const limite = res.status === 429 || txt.includes('RESOURCE_EXHAUSTED')
    const saturada = res.status === 503 || res.status === 500 || txt.includes('UNAVAILABLE')
    throw new IAError(limite ? 'limite' : saturada || res.status === 404 ? 'saturada' : 'red', `${modelo} HTTP ${res.status}: ${txt.slice(0, 300)}`)
  }

  const data = await res.json().catch(() => null) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] } | null
  const texto = data?.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? ''
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

export async function generarJSON<T>(opts: {
  sistema: string
  turnos: TurnoIA[]
  /** Esquema OpenAPI (subconjunto de Gemini: type en MAYÚSCULAS, enum, nullable, required) */
  esquema: Record<string, unknown>
  temperatura?: number
  timeoutMs?: number
  modo?: ModoIA
}): Promise<T> {
  if (!iaConfigurada()) throw new IAError('no_configurada', 'Falta GEMINI_API_KEY')

  const modo = opts.modo ?? 'rapido'
  const cuerpo = {
    systemInstruction: { parts: [{ text: opts.sistema }] },
    contents: opts.turnos,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: opts.esquema,
      temperature: opts.temperatura ?? 0.3,
    },
  }
  const modelos = cadenaModelos(modo)
  const presupuestoMs = opts.timeoutMs ?? 30000
  const inicio = Date.now()

  return new Promise<T>((resolve, reject) => {
    let siguiente = 0, activos = 0, terminado = false, huboLimite = false
    let ultimo: IAError | null = null
    const controles: AbortController[] = []
    let respaldo: NodeJS.Timeout | undefined

    const terminar = (fn: () => void) => {
      if (terminado) return
      terminado = true
      clearTimeout(respaldo); clearTimeout(limiteTotal)
      controles.forEach(c => c.abort())
      fn()
    }
    const fallar = () => {
      // Todos los modelos fallaron: si alguno fue por cuota, es un límite de uso
      if (huboLimite && ultimo?.codigo !== 'saturada' && ultimo?.codigo !== 'respuesta_invalida') return terminar(() => reject(ultimo!))
      terminar(() => reject(ultimo ?? new IAError('saturada', 'sin respuesta tras probar todos los modelos')))
    }
    const limiteTotal = setTimeout(() => {
      console.warn(`[IA] sin respuesta en ${presupuestoMs} ms (${modelos.slice(0, siguiente).join(', ')})`)
      if (!ultimo || ultimo.codigo === 'red') ultimo = new IAError('saturada', 'tiempo agotado')
      fallar()
    }, presupuestoMs)

    const lanzar = () => {
      if (terminado || siguiente >= modelos.length) return
      const modelo = modelos[siguiente++]
      const ctrl = new AbortController(); controles.push(ctrl)
      activos++
      // Si este no contesta pronto, el siguiente sale en paralelo
      clearTimeout(respaldo)
      if (siguiente < modelos.length) respaldo = setTimeout(lanzar, ESPERA_RESPALDO_MS[modo])
      const t0 = Date.now()
      intento<T>(modelo, cuerpo, ctrl.signal).then(
        out => {
          const ms = Date.now() - t0
          if (ms > 8000 || Date.now() - inicio > 8000) console.warn(`[IA] ${modelo} respondió en ${ms} ms (total ${Date.now() - inicio} ms)`)
          terminar(() => resolve(out))
        },
        (e: unknown) => {
          activos--
          if (terminado) return
          const err = e instanceof IAError ? e : new IAError('red', String(e))
          if (err.codigo === 'clave_invalida') return terminar(() => reject(err))
          if (err.codigo === 'limite') huboLimite = true
          // Un fallo de red de verdad (sin internet) no se arregla con otro modelo
          if (err.codigo === 'red' && !/HTTP \d/.test(err.message) && activos === 0) { ultimo = err; return fallar() }
          ultimo = err
          console.warn(`[IA] ${modelo}: ${err.codigo}${siguiente < modelos.length ? '; probando el siguiente modelo' : ''}`)
          if (siguiente < modelos.length) lanzar()
          else if (activos === 0) fallar()
        },
      )
    }
    lanzar()
  })
}
