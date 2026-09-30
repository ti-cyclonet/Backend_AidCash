import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'
import { numeroFueraDeRango } from '../lib/validacion.js'

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Parse and assign back to req.body so coerced/transformed values are available
      req.body = schema.parse(req.body)
      // Ningún monto de Kiri pasa de 5.000 millones: más que eso no cabe en la
      // base de datos (antes salía un 500) y en la práctica es un error de digitación
      if (numeroFueraDeRango(req.body)) {
        res.status(400).json({ error: 'El valor es demasiado grande. Revisa el monto.' })
        return
      }
      next()
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(e => ({
          campo: e.path.join('.'),
          mensaje: e.message,
        }))
        res.status(400).json({ error: 'Datos inválidos', detalles: errors })
        return
      }
      next(error)
    }
  }
}
