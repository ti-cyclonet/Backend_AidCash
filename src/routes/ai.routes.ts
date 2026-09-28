import { Router, Request, Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { generarJSON, iaConfigurada, IAError, MENSAJE_IA, type TurnoIA } from '../lib/ai/gemini.js'
import { construirContexto, contextoComoTexto } from '../lib/ai/contexto.js'
import { ESQUEMA_ACCION, REGLAS_ACCIONES, normalizarAcciones } from '../lib/ai/acciones.js'
import { MANUAL_KIRI } from '../lib/ai/conocimiento.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Coach, dictado por voz y escáner de recibos (IA)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Los tres reciben el contexto financiero REAL del usuario (lib/ai/contexto.ts)
 * y devuelven "acciones" (lib/ai/acciones.ts) que el frontend muestra para que
 * el usuario revise y confirme — la IA nunca guarda nada por su cuenta.
 */
const router = Router()
router.use(authMiddleware)

// Protege la cuota de Google AI: por usuario, no por IP
const limiteIA = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => (req as Request).user?.userId ?? 'anon',
  message: { error: 'Estás usando mucho a Kiri Coach. Espera unos minutos e intenta de nuevo.', codigo: 'limite' },
})

const RUTAS = ['/jardin', '/gestion', '/gestion?tab=presupuesto', '/gestion?tab=proyecciones', '/obligaciones', '/balance', '/ahorro', '/social', '/misiones', '/perfil']

function responderError(res: Response, error: unknown, donde: string) {
  if (error instanceof IAError) {
    console.warn(`[IA ${donde}] ${error.codigo}: ${error.message.slice(0, 160)}`)
    res.status(error.codigo === 'limite' ? 429 : 503).json({ error: MENSAJE_IA[error.codigo], codigo: error.codigo })
    return
  }
  console.error(`[IA ${donde}]`, error)
  res.status(500).json({ error: 'Algo falló con Kiri Coach. Intenta de nuevo.', codigo: 'error' })
}

const PERSONALIDAD = `Eres Kiri 🌱, el coach financiero de Kiri Finance y el mayor experto en esta app.
Hablas español de Colombia, tuteas, eres cálido, claro y motivador (celebra los avances reales),
pero directo cuando algo va mal. Tus números salen SOLO de los datos del usuario que tienes abajo:
nunca inventes cifras, estadísticas ni "estudios"; si algo es estimado, dilo ("aprox."). Solo hablas
de funciones que existen en el manual; si te preguntan por algo que Kiri no hace, dilo con honestidad.`

// ─── GET /ai/estado — ¿la IA está activa? ─────────────────────────────────────

router.get('/estado', (_req: Request, res: Response) => {
  res.json({ activa: iaConfigurada() })
})

// ─── POST /ai/coach — chat ────────────────────────────────────────────────────

const coachSchema = z.object({
  mensaje: z.string().trim().min(1).max(2000),
  historial: z.array(z.object({ rol: z.enum(['usuario', 'coach']), texto: z.string().max(4000) })).max(20).optional(),
  pantalla: z.string().max(80).optional(),
}).strict()

const ESQUEMA_COACH = {
  type: 'OBJECT',
  properties: {
    respuesta: { type: 'STRING', description: 'Tu respuesta al usuario. Puedes usar **negritas** y listas con "- " o "1. ".' },
    acciones: { type: 'ARRAY', items: ESQUEMA_ACCION, description: 'Movimientos para registrar si el usuario lo pidió. [] si no.' },
    sugerencias: { type: 'ARRAY', items: { type: 'STRING' }, description: '2 o 3 preguntas cortas de seguimiento que el usuario podría tocar' },
    ir: {
      type: 'OBJECT', nullable: true,
      properties: { ruta: { type: 'STRING', enum: RUTAS }, etiqueta: { type: 'STRING' } },
      required: ['ruta', 'etiqueta'],
      description: 'Pantalla de Kiri a la que conviene ir (ej. para ver o hacer lo que explicaste). null si no aplica.',
    },
  },
  required: ['respuesta', 'acciones', 'sugerencias'],
}

router.post('/coach', limiteIA, validate(coachSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { mensaje, historial = [], pantalla } = req.body as z.infer<typeof coachSchema>
    const ctx = await construirContexto(req.user!.userId)
    const sistema = `${PERSONALIDAD}

CÓMO RESPONDER:
- Respuestas cortas (máx. ~120 palabras) salvo que pida que le expliques la app, un módulo o una
  función: ahí explica paso a paso y con detalle (dónde está el botón, qué hace, qué pasa después).
- Si pregunta por sus finanzas, analiza con sus datos: compara meses del historial, categorías que
  se pasan, deudas más caras, pagos pendientes, y da UNA acción concreta con su impacto.
- Si pregunta por un movimiento ("¿por qué bajó mi saldo?", "¿qué fue ese pago?"), búscalo en los
  últimos movimientos y explícalo.
- Si pide registrar, crear, pagar, ahorrar o prestar algo: propón las "acciones" y di algo como
  "Te dejé listo el registro abajo: revísalo y confírmalo". NUNCA digas que ya quedó guardado.
  Si falta un dato imprescindible (ej. la cuota de una deuda), pregúntalo en la respuesta.
- "ir": sugiere la pantalla adecuada cuando ayude (ej. al explicar Proyecciones → /gestion?tab=proyecciones).
- Cierra, cuando tenga sentido, con una pregunta que invite a actuar.
${pantalla ? `- El usuario está ahora en la pantalla: ${pantalla}` : ''}

${REGLAS_ACCIONES}

═══ MANUAL DE LA APP ═══
${MANUAL_KIRI}

═══ DATOS REALES DEL USUARIO ═══
${contextoComoTexto(ctx)}`

    const turnos: TurnoIA[] = [
      ...historial.slice(-10).map(h => ({ role: (h.rol === 'coach' ? 'model' : 'user') as 'user' | 'model', parts: [{ text: h.texto }] })),
      { role: 'user', parts: [{ text: mensaje }] },
    ]
    const out = await generarJSON<{ respuesta?: string; acciones?: unknown; sugerencias?: unknown; ir?: { ruta?: string; etiqueta?: string } | null }>({
      sistema, turnos, esquema: ESQUEMA_COACH, temperatura: 0.5,
    })
    res.json({
      respuesta: String(out.respuesta ?? '').trim() || 'No te entendí bien, ¿me lo cuentas de otra forma?',
      acciones: normalizarAcciones(out.acciones, ctx),
      sugerencias: Array.isArray(out.sugerencias) ? out.sugerencias.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      ir: out.ir?.ruta && RUTAS.includes(out.ir.ruta) ? { ruta: out.ir.ruta, etiqueta: String(out.ir.etiqueta ?? 'Ir') } : null,
    })
  } catch (error) {
    responderError(res, error, 'coach')
  }
})

// ─── POST /ai/dictado — lo que el usuario dijo por voz ────────────────────────

const dictadoSchema = z.object({ transcripcion: z.string().trim().min(1).max(3000) }).strict()

const ESQUEMA_EXTRACCION = {
  type: 'OBJECT',
  properties: {
    resumen: { type: 'STRING', description: 'Qué entendiste y a dónde va cada cosa, en 1-3 frases cálidas' },
    acciones: { type: 'ARRAY', items: ESQUEMA_ACCION },
    confianza: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
  },
  required: ['resumen', 'acciones', 'confianza'],
}

router.post('/dictado', limiteIA, validate(dictadoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { transcripcion } = req.body as z.infer<typeof dictadoSchema>
    const ctx = await construirContexto(req.user!.userId)
    const sistema = `${PERSONALIDAD}

El usuario dictó por voz lo que hizo con su plata. Conviértelo en acciones para registrar en Kiri.
El texto viene de reconocimiento de voz: puede tener errores ("mil" mal escrito, nombres raros);
interpreta con sentido común. Relaciona lo que dice con SUS datos: si nombra una obligación,
bolsillo, categoría o persona que existe, usa ese id.

${REGLAS_ACCIONES}

═══ DATOS REALES DEL USUARIO ═══
${contextoComoTexto(ctx)}`
    const out = await generarJSON<{ resumen?: string; acciones?: unknown; confianza?: string }>({
      sistema, turnos: [{ role: 'user', parts: [{ text: `Dictado: "${transcripcion}"` }] }], esquema: ESQUEMA_EXTRACCION, temperatura: 0.2,
    })
    res.json({
      resumen: String(out.resumen ?? ''),
      acciones: normalizarAcciones(out.acciones, ctx),
      confianza: ['alta', 'media', 'baja'].includes(String(out.confianza)) ? out.confianza : 'media',
    })
  } catch (error) {
    responderError(res, error, 'dictado')
  }
})

// ─── POST /ai/recibo — foto de un recibo o factura ────────────────────────────

const reciboSchema = z.object({
  imageBase64: z.string().min(100).max(9_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
}).strict()

const ESQUEMA_RECIBO = {
  type: 'OBJECT',
  properties: {
    esRecibo: { type: 'BOOLEAN', description: 'false si la imagen no es un recibo, factura, comprobante o extracto' },
    establecimiento: { type: 'STRING', description: 'Comercio o entidad. Vacío si no se lee.' },
    fecha: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD si se lee' },
    total: { type: 'NUMBER', description: 'Total pagado en pesos (entero). 0 si no se lee.' },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { descripcion: { type: 'STRING' }, monto: { type: 'NUMBER' } }, required: ['descripcion', 'monto'] } },
    nombreClaro: { type: 'BOOLEAN', description: 'true si se entiende qué se compró o pagó (comercio o concepto)' },
    confianza: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
    acciones: { type: 'ARRAY', items: ESQUEMA_ACCION },
  },
  required: ['esRecibo', 'establecimiento', 'total', 'items', 'nombreClaro', 'confianza', 'acciones'],
}

router.post('/recibo', limiteIA, validate(reciboSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { imageBase64, mimeType } = req.body as z.infer<typeof reciboSchema>
    const ctx = await construirContexto(req.user!.userId)
    const sistema = `Eres el lector de recibos de Kiri Finance (Colombia, pesos COP).
Lee la imagen y extrae comercio, fecha, total e ítems. En Colombia el punto separa miles
("$12.500" = 12500) y la coma los decimales; el total suele ser el valor más grande al final
("TOTAL", "VALOR A PAGAR", "TOTAL A PAGAR"). Ignora propinas sugeridas no pagadas.

Luego propone UNA acción para registrar el total (o [] si no hay total):
- Factura de un servicio o pago recurrente que coincide con un GASTO FIJO o DEUDA del usuario
  (luz, agua, gas, internet, celular, arriendo, extracto de su tarjeta, cuota) → pago_obligacion
  con ese id.
- Compra normal → gasto, con la categoría que mejor encaje y esHormiga si es pequeña/cotidiana.
- Si se lee el valor pero NO se entiende a qué corresponde → sin_destino (nombreClaro=false).
Si la imagen no es un recibo (esRecibo=false), acciones = [].

${REGLAS_ACCIONES}

═══ DATOS REALES DEL USUARIO ═══
${contextoComoTexto(ctx)}`
    const out = await generarJSON<{ esRecibo?: boolean; establecimiento?: string; fecha?: string | null; total?: number; items?: { descripcion?: string; monto?: number }[]; nombreClaro?: boolean; confianza?: string; acciones?: unknown }>({
      sistema,
      turnos: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: 'Lee este recibo.' }] }],
      esquema: ESQUEMA_RECIBO, temperatura: 0.1, timeoutMs: 60000,
    })
    const total = Math.round(Math.abs(Number(out.total) || 0))
    let acciones = normalizarAcciones(out.acciones, ctx)
    // Leyó el valor pero no propuso nada: que el usuario elija el destino
    if (out.esRecibo !== false && total > 0 && acciones.length === 0) {
      acciones = normalizarAcciones([{ tipo: 'sin_destino', nombre: out.nombreClaro ? out.establecimiento : '', monto: total }], ctx)
    }
    res.json({
      esRecibo: out.esRecibo !== false,
      establecimiento: String(out.establecimiento ?? '').trim(),
      fecha: typeof out.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(out.fecha) ? out.fecha : null,
      total,
      items: (out.items ?? [])
        .map(i => ({ descripcion: String(i.descripcion ?? '').trim(), monto: Math.round(Math.abs(Number(i.monto) || 0)) }))
        .filter(i => i.descripcion && i.monto > 0)
        .slice(0, 40),
      nombreClaro: out.nombreClaro !== false,
      confianza: ['alta', 'media', 'baja'].includes(String(out.confianza)) ? out.confianza : 'media',
      acciones,
    })
  } catch (error) {
    responderError(res, error, 'recibo')
  }
})

export default router
