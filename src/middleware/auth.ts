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

    // Gate por aplicación: un token de Authoriza solo habilita Kiri si su rol
    // pertenece a Kiri. Un token de otra app (InOut/Shotra/FactoNet) NO da acceso.
    const KIRI_ROLES = ['adminKiri', 'userKiri']
    if (payload.rol && !KIRI_ROLES.includes(payload.rol)) {
      res.status(403).json({
        error: 'Este token no tiene acceso a Kiri. Inicia sesión en Kiri.',
        code: 'WRONG_APP_TOKEN',
      })
      return
    }

    // tenantId = dueño del contrato (lo emite Authoriza). No usar contractId como
    // fallback (namespace distinto). Kiri scopea por userId igualmente.
    const tenantId = payload.tenantId || null
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
