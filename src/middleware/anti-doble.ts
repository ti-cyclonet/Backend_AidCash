import type { Request, Response, NextFunction } from 'express'
import { createHash } from 'crypto'

/**
 * Doble toque → un solo registro. En el celular es común tocar dos veces "Registrar"
 * o "Pagar" antes de que el botón alcance a deshabilitarse: llegaban dos peticiones
 * iguales y quedaban dos gastos o dos pagos.
 *
 * Si llega una petición idéntica (misma sesión, misma ruta, mismo cuerpo) mientras la
 * primera está en curso o hasta 4 s después de que salió bien, se responde lo mismo que
 * a la primera, sin volver a ejecutarla. Las que fallan no se guardan (se pueden reintentar).
 */
const VENTANA_MS = 4000
interface Resultado { status: number; body: unknown }
const recientes = new Map<string, { hasta: number; resultado: Promise<Resultado | null> }>()

setInterval(() => {
  const ahora = Date.now()
  for (const [k, v] of recientes) if (v.hasta < ahora) recientes.delete(k)
}, 30_000).unref()

export function antiDoble(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return next()
  const sesion = String(req.headers.authorization || '')
  if (!sesion) return next()
  const clave = createHash('sha1').update(`${req.method} ${req.originalUrl} ${sesion} ${JSON.stringify(req.body ?? null)}`).digest('hex')
  const previo = recientes.get(clave)
  if (previo && previo.hasta > Date.now()) {
    previo.resultado.then(r => {
      if (r) { res.setHeader('x-kiri-repetida', '1'); res.status(r.status).json(r.body) }
      else next()
    })
    return
  }
  let resolver!: (r: Resultado | null) => void
  const resultado = new Promise<Resultado | null>(r => { resolver = r })
  // Mientras está en curso, la ventana sigue abierta; se cierra 4 s después de responder
  recientes.set(clave, { hasta: Date.now() + 60_000, resultado })
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    const ok = res.statusCode >= 200 && res.statusCode < 300
    resolver(ok ? { status: res.statusCode, body } : null)
    if (ok) recientes.set(clave, { hasta: Date.now() + VENTANA_MS, resultado })
    else recientes.delete(clave)
    return json(body)
  }
  res.on('close', () => { if (!res.writableEnded) { resolver(null); recientes.delete(clave) } })
  next()
}
