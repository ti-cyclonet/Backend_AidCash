import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Parse and assign back to req.body so coerced/transformed values are available
      req.body = schema.parse(req.body)
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
