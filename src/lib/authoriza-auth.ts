import { env } from '../config/env.js'

/**
 * Authoriza es el ÚNICO dueño de las contraseñas del ecosistema. Kiri ya no
 * valida contra su columna local `password_hash` (que se desincronizaba: un
 * reset en Authoriza dejaba funcionando la contraseña vieja en Kiri); valida y
 * cambia contraseñas a través de estos endpoints internos (x-internal-key).
 */

/** Valor que se guarda en `users.password_hash` para cuentas nuevas: no es un hash bcrypt, nunca valida. */
export const AUTHORIZA_MANAGED_PASSWORD = '!authoriza-managed'

/** Authoriza no respondió (red caída o 5xx): el login debe fallar cerrado. */
export class AuthorizaUnavailableError extends Error {
  constructor(message = 'Authoriza no disponible') {
    super(message)
    this.name = 'AuthorizaUnavailableError'
  }
}

/** Authoriza respondió con un error de negocio (4xx) — se muestra al usuario. */
export class AuthorizaRejectedError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'AuthorizaRejectedError'
  }
}

export interface CredentialsResult {
  exists: boolean
  valid: boolean
  allowed: boolean
  status: string | null
  reason?: string
  mustChangePassword: boolean
  /** Avatar vigente en Authoriza (null si no tiene foto) */
  avatarUrl?: string | null
}

async function callInternal<T>(path: string, body: unknown): Promise<T> {
  let res: globalThis.Response
  try {
    res = await fetch(`${env.AUTHORIZA_API_URL}/api/auth/internal/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    throw new AuthorizaUnavailableError((err as Error).message)
  }

  const data = (await res.json().catch(() => ({}))) as any
  // 401 del guard interno = INTERNAL_API_KEY mal configurada: es un fallo de
  // configuración, no del usuario — tratarlo como "no disponible".
  if (res.status >= 500 || (res.status === 401 && path === 'verify-credentials')) {
    throw new AuthorizaUnavailableError(`HTTP ${res.status}`)
  }
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message[0] : data?.message
    throw new AuthorizaRejectedError(res.status, message || 'Authoriza rechazó la solicitud.')
  }
  return data as T
}

export function verifyCredentials(email: string, password: string): Promise<CredentialsResult> {
  return callInternal<CredentialsResult>('verify-credentials', { email, password })
}

/**
 * Fija la contraseña en Authoriza. Con `currentPassword` es un cambio voluntario
 * (Authoriza valida la actual); sin ella, un reset cuyo token ya validó Kiri.
 */
export function setPassword(email: string, newPassword: string, currentPassword?: string): Promise<{ message: string }> {
  return callInternal('set-password', { email, newPassword, ...(currentPassword !== undefined ? { currentPassword } : {}) })
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
// La foto de perfil también vive SOLO en Authoriza (compartida por todas las
// apps). Kiri guarda una copia de la URL en users.avatar_url para mostrar la
// foto de otros usuarios (Social) sin consultar Authoriza en cada vista.

/** Sube a Authoriza una imagen en data URL base64 y devuelve la URL alojada. */
export async function setAuthorizaAvatar(email: string, dataUrl: string): Promise<string> {
  const data = await callInternal<{ url: string }>('set-avatar', { email, dataUrl })
  if (!data?.url) throw new AuthorizaRejectedError(502, 'Authoriza no devolvió la foto.')
  return data.url
}

/** Avatar vigente en Authoriza: URL, null si no tiene, o undefined si no respondió. */
export async function getAuthorizaAvatar(email: string): Promise<string | null | undefined> {
  try {
    const data = await callInternal<{ url: string | null }>('avatar', { email })
    return data?.url || null
  } catch {
    return undefined
  }
}

/**
 * Cuentas antiguas que existen solo en Kiri: crea su cuenta en Authoriza con
 * la contraseña dada (ya verificada y activa). Solo debe llamarse cuando la
 * propiedad del correo está probada (p. ej. token de reset enviado por correo).
 */
export async function ensureAuthorizaAccount(email: string, password: string, nombre?: string): Promise<void> {
  let res: globalThis.Response
  try {
    res = await fetch(`${env.AUTHORIZA_API_URL}/api/auth/ensure-kiri-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ email, password, nombre }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    throw new AuthorizaUnavailableError((err as Error).message)
  }
  if (res.status >= 500) throw new AuthorizaUnavailableError(`HTTP ${res.status}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as any
    throw new AuthorizaRejectedError(res.status, data?.message || 'Authoriza rechazó la solicitud.')
  }
}
