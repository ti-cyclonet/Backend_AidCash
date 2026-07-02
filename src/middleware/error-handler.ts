import { Request, Response, NextFunction } from 'express'
import { env } from '../config/env.js'

export class AppError extends Error {
  statusCode: number
  isOperational: boolean

  constructor(message: string, statusCode: number = 500) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }

  console.error('❌ Error no manejado:', err)

  res.status(500).json({
    error: env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message,
  })
}
