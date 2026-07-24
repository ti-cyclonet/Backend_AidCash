import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export interface AuthPayload {
  userId: string
  correo: string
  // Campos de Authoriza (opcionales — presentes cuando el token viene de Authoriza)
  tenantId?: string
  rol?: string
  source?: 'kiri' | 'authoriza'
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload
    }
  }
}

/**
 * Middleware de autenticación dual.
 * Intenta validar el token primero con el secret de Kiri (tokens locales),
 * y si falla, intenta con el secret de Authoriza (tokens del ecosistema Cyclonet).
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de autorización requerido' })
    return
  }

  const token = authHeader.split(' ')[1]

  // 1. Intentar con el secret propio de Kiri
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as any
    req.user = {
      userId: payload.userId || payload.sub,
      correo: payload.correo || payload.email,
      source: 'kiri',
    }
    next()
    return
  } catch {
    // Token no es de Kiri, intentar con Authoriza
  }

  // 2. Intentar con el secret de Authoriza
  try {
    const payload = jwt.verify(token, env.AUTHORIZA_JWT_SECRET) as any
    const tenantId = payload.basicDataId || payload.tenantId || payload.contractId || payload.contract_id
    req.user = {
      userId: payload.sub || payload.id,
      correo: payload.email || payload.username,
      tenantId,
      rol: payload.rol,
      source: 'authoriza',
    }
    next()
    return
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' })
      return
    }
    res.status(401).json({ error: 'Token inválido' })
  }
}
