import { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'

/**
 * Webhooks servidor-a-servidor (Authoriza → Kiri): exige la cabecera
 * x-internal-key igual a INTERNAL_API_KEY. Si la variable no está configurada
 * (o es corta), la ruta queda CERRADA: nunca abierta por defecto.
 */
export function requireInternalKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY || ''
  const provided = String(req.headers['x-internal-key'] || '')
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (expected.length >= 16 && a.length === b.length && timingSafeEqual(a, b)) {
    next()
    return
  }
  res.status(401).json({ success: false, error: 'No autorizado.' })
}
