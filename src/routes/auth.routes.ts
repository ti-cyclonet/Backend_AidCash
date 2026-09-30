import { Router, Request, Response } from 'express'
import { LEGAL_VERSIONS, aceptaVersionesVigentes, consentimientoPendiente, consentPayload, consentLocalData, authorizaInternalHeaders } from '../lib/legal.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { aplicarInvitacionAlRegistro, acreditarReferido } from '../lib/invitaciones.js'
import { DIAS_PRUEBA_REGISTRO } from '../lib/planes.js'
import { env } from '../config/env.js'
import { validate } from '../middleware/validate.js'
import { authMiddleware, AuthPayload } from '../middleware/auth.js'
import { generateUniqueUsername } from '../lib/username.js'
import { sendMail } from '../lib/mail.js'
import crypto from 'crypto'
import { ingresoPromedioMensual, partirNombre, unirNombre } from '../lib/ingresos.js'
import {
  AUTHORIZA_MANAGED_PASSWORD,
  AuthorizaRejectedError,
  ensureAuthorizaAccount,
  getAuthorizaAvatar, getAuthorizaName,
  setPassword as setAuthorizaPassword,
  verifyCredentials,
} from '../lib/authoriza-auth.js'

const router = Router()

// ─── Schemas de validación ────────────────────────────────────────────────────

const registerSchema = z.object({
  nombre: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  correo: z.string().email('Correo electrónico inválido'),
  password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres'),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
  firstName: z.string().optional(),
  secondName: z.string().optional(),
  firstSurname: z.string().optional(),
  secondSurname: z.string().optional(),
  // Código del enlace de invitación con el que llegó (ver lib/invitaciones.ts)
  invitacion: z.string().max(40).optional(),
  // Términos y autorización de datos: obligatorios, en su versión vigente
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar los Términos y Condiciones.' }) }),
  acceptHabeasData: z.literal(true, { errorMap: () => ({ message: 'Debes autorizar el tratamiento de tus datos personales.' }) }),
  termsVersion: z.string().max(60),
  habeasDataVersion: z.string().max(60),
})

const consentimientoSchema = z.object({
  acceptTerms: z.literal(true),
  acceptHabeasData: z.literal(true),
  termsVersion: z.string().max(60),
  habeasDataVersion: z.string().max(60),
})

const loginSchema = z.object({
  correo: z.string().email('Correo electrónico inválido'),
  password: z.string().min(1, 'La contraseña es requerida'),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateAccessToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions)
}

function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex')
}

function getRefreshExpiry(): Date {
  const days = parseInt(env.JWT_REFRESH_EXPIRES_IN) || 30
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

router.post('/register', validate(registerSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { nombre, correo, password, documentType, documentNumber, firstName, secondName, firstSurname, secondSurname, invitacion } = req.body
    if (!aceptaVersionesVigentes(req.body)) {
      // Versión distinta = la app tiene un texto viejo en caché: que recargue
      res.status(409).json({ error: 'Los Términos o la autorización de datos se actualizaron. Recarga la página y acéptalos de nuevo.', code: 'LEGAL_VERSION' })
      return
    }

    // Verificar si el correo ya existe
    const existing = await prisma.user.findUnique({ where: { correo } })
    if (existing) {
      res.status(409).json({ error: 'Este correo ya está registrado.' })
      return
    }

    // @username público (Social) — se autogenera del nombre, editable después
    const username = await generateUniqueUsername(nombre)

    // Crear usuario local INACTIVO (pendiente de verificación de correo)
    const user = await prisma.user.create({
      data: {
        nombre,
        // Partes del nombre tal como las escribió (Perfil las edita por separado)
        ...(firstName && firstSurname ? {
          primerNombre: String(firstName).trim(), segundoNombre: secondName ? String(secondName).trim() : null,
          primerApellido: String(firstSurname).trim(), segundoApellido: secondSurname ? String(secondSurname).trim() : null,
        } : {}),
        correo,
        username,
        // La contraseña vive solo en Authoriza (se envía abajo en register-kiri)
        passwordHash: AUTHORIZA_MANAGED_PASSWORD,
        isActive: false, // Inactivo hasta verificar el correo
        frecuenciaIngreso: 'mensual',
        ingresoBase: 0,
        onboardingDone: false,
        metaAhorroGlobal: 5000,
        saldoAhorroTotal: 0,
        fondoEmergenciaActual: 0,
        // 14 días de KIRI PLUS para conocer todo (lib/planes.ts)
        pruebaPlusHasta: new Date(Date.now() + DIAS_PRUEBA_REGISTRO * 86400000),
        // Aceptó los Términos y la autorización de datos vigentes (Authoriza guarda la prueba)
        ...consentLocalData(),
      },
    })

    // Registrar en Authoriza con verificación de correo
    let verificationRequired = true
    try {
      const authorizaUrl = env.AUTHORIZA_API_URL || 'http://localhost:3000'
      const authRes = await fetch(`${authorizaUrl}/api/auth/register-kiri`, {
        method: 'POST',
        // Como servicio: así Authoriza registra la IP y el navegador del usuario
        // (consentMeta) y no los del servidor de Kiri
        headers: authorizaInternalHeaders(),
        body: JSON.stringify({
          ...consentPayload(req),
          email: correo,
          password,
          firstName: firstName || nombre,
          secondName: secondName || undefined,
          firstSurname: firstSurname || '',
          secondSurname: secondSurname || undefined,
          documentType: documentType || 'CC',
          documentNumber: documentNumber || '',
        }),
      })
      const authData = await authRes.json().catch(() => ({})) as any
      if (!authRes.ok) {
        // Sin cuenta en Authoriza no hay contraseña con la que entrar: no dejar
        // una fila local huérfana que después bloquee el registro con "ya existe".
        await prisma.user.delete({ where: { id: user.id } }).catch(() => {})
        const message = Array.isArray(authData?.message) ? authData.message[0] : authData?.message
        res.status(authRes.status === 409 ? 409 : 502).json({
          error: message || 'No se pudo completar el registro. Intenta de nuevo.',
        })
        return
      }
      // Cuenta CycloNet existente y verificada (misma contraseña): activar local
      if (authData.alreadyExists && authData.verificationRequired === false) {
        verificationRequired = false
        await prisma.user.update({ where: { id: user.id }, data: { isActive: true } })
      }
    } catch (authErr) {
      console.warn('[Register] Failed to register in Authoriza:', (authErr as Error).message)
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {})
      res.status(503).json({ error: 'No pudimos completar el registro en este momento. Intenta de nuevo en unos minutos.' })
      return
    }

    // Llegó con un enlace de invitación (y el registro sí se completó): queda
    // conectado en Social con quien lo invitó. La misión de quien invitó se
    // acredita cuando esta cuenta nueva verifique su correo (ver login).
    if (invitacion) await aplicarInvitacionAlRegistro(invitacion, user.id, nombre)

    res.status(201).json({
      user: {
        id: user.id,
        nombre: user.nombre,
        correo: user.correo,
        onboardingDone: user.onboardingDone,
      },
      verificationRequired,
      message: verificationRequired
        ? 'Registro exitoso. Revisa tu correo para verificar tu cuenta antes de iniciar sesión.'
        : 'Registro exitoso.',
    })
  } catch (error) {
    console.error('[Register]', error)
    res.status(500).json({ error: 'Error al crear la cuenta' })
  }
})

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post('/login', validate(loginSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const correo = String(req.body.correo).trim()
    const { password } = req.body

    // 1. La contraseña se valida SOLO contra Authoriza (fuente de verdad). Si
    //    no responde, el login falla cerrado: nunca se cae a una copia local.
    let cred
    try {
      cred = await verifyCredentials(correo, password)
    } catch (err) {
      console.warn('[Login] Authoriza no disponible:', (err as Error).message)
      res.status(503).json({
        error: 'No pudimos validar tu acceso en este momento. Intenta de nuevo en unos minutos.',
        code: 'AUTH_UNAVAILABLE',
      })
      return
    }

    const user = await prisma.user.findUnique({ where: { correo } })

    if (!cred.exists && user) {
      // Cuenta antigua que solo existía en Kiri: su contraseña local ya no se
      // acepta. Recuperarla por correo crea la cuenta en Authoriza.
      res.status(403).json({
        error: 'Tu cuenta de Kiri debe migrarse a CycloNet. Usa "¿Olvidaste tu contraseña?" para crear tu nueva contraseña.',
        code: 'LEGACY_ACCOUNT',
      })
      return
    }

    if (!cred.valid) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos.' })
      return
    }

    if (!user) {
      // Cuenta CycloNet válida pero aún sin perfil en Kiri
      res.status(403).json({
        error: 'Tu cuenta CycloNet aún no está habilitada en Kiri. Regístrate en Kiri con este correo y tu misma contraseña.',
        code: 'NOT_IN_KIRI',
      })
      return
    }

    // 2. Estado de acceso (Authoriza manda)
    if (!cred.allowed) {
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } }).catch(() => {})
      const messages: Record<string, string> = {
        NOT_VERIFIED: 'Debes verificar tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.',
        UNCONFIRMED: 'Debes verificar tu correo antes de iniciar sesión. Revisa tu bandeja de entrada.',
        SUSPENDED: 'Tu cuenta ha sido suspendida. Contacta al administrador.',
        INACTIVE: 'Tu cuenta está inactiva. Contacta al administrador.',
        DELINQUENT: 'Tu cuenta tiene un pago pendiente. Regulariza tu situación para continuar.',
        DELETED: 'Esta cuenta ya no está disponible.',
      }
      res.status(403).json({
        error: messages[cred.reason || ''] || 'Tu acceso ha sido restringido. Contacta al administrador.',
        code: 'ACCESS_DENIED',
        reason: cred.reason,
      })
      return
    }
    if (user.isActive === false) {
      await prisma.user.update({ where: { id: user.id }, data: { isActive: true } }).catch(() => {})
      user.isActive = true
      // Primera vez que entra tras verificar el correo: si llegó invitado, ahora
      // sí cuenta para la misión de quien lo invitó (solo la primera sesión).
      if (user.invitedById && (await prisma.refreshToken.count({ where: { userId: user.id } })) === 0) {
        acreditarReferido(user.id).catch(() => {})
      }
    }
    // Avatar vigente de Authoriza (pudo cambiarse desde otra app)
    if (cred.avatarUrl && cred.avatarUrl !== user.avatarUrl) {
      await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: cred.avatarUrl } }).catch(() => {})
    }

    // Generar tokens
    const tokenPayload: AuthPayload = { userId: user.id, correo: user.correo }
    const accessToken = generateAccessToken(tokenPayload)
    const refreshToken = generateRefreshToken()

    // Guardar refresh token
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: getRefreshExpiry(),
      },
    })

    res.json({
      user: {
        id: user.id,
        nombre: user.nombre,
        correo: user.correo,
        onboardingDone: user.onboardingDone,
        guiasVistas: user.guiasVistas,
      },
      accessToken,
      refreshToken,
      // Tras un reset desde Authoriza (contraseña temporal): el frontend obliga
      // a cambiarla antes de dejar usar la app.
      mustChangePassword: cred.mustChangePassword,
    })
  } catch (error) {
    console.error('[Login]', error)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token requerido' })
      return
    }

    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    })

    if (!stored || stored.expiresAt < new Date()) {
      if (stored) {
        await prisma.refreshToken.delete({ where: { id: stored.id } })
      }
      res.status(401).json({ error: 'Refresh token inválido o expirado' })
      return
    }

    // Verificar que el usuario esté activo
    if (stored.user.isActive === false) {
      await prisma.refreshToken.delete({ where: { id: stored.id } })
      res.status(403).json({
        error: 'Tu cuenta está temporalmente suspendida mientras se aprueba tu cambio de plan.',
        code: 'ACCOUNT_SUSPENDED',
      })
      return
    }

    // Rotar el refresh token
    await prisma.refreshToken.delete({ where: { id: stored.id } })

    const tokenPayload: AuthPayload = { userId: stored.user.id, correo: stored.user.correo }
    const newAccessToken = generateAccessToken(tokenPayload)
    const newRefreshToken = generateRefreshToken()

    await prisma.refreshToken.create({
      data: {
        userId: stored.user.id,
        token: newRefreshToken,
        expiresAt: getRefreshExpiry(),
      },
    })

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    })
  } catch (error) {
    console.error('[Refresh]', error)
    res.status(500).json({ error: 'Error al refrescar el token' })
  }
})

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post('/logout', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body

    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken },
      })
    }

    res.json({ message: 'Sesión cerrada correctamente' })
  } catch (error) {
    console.error('[Logout]', error)
    res.status(500).json({ error: 'Error al cerrar sesión' })
  }
})

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        nombre: true,
        correo: true,
        username: true,
        avatarUrl: true,
        primerNombre: true,
        segundoNombre: true,
        primerApellido: true,
        segundoApellido: true,
        ingresoBase: true,
        frecuenciaIngreso: true,
        tipoIngreso: true,
        ingresoQuincena1: true,
        ingresoQuincena2: true,
        diasPago: true,
        onboardingDone: true,
        metaAhorroGlobal: true,
        saldoAhorroTotal: true,
        fondoEmergenciaActual: true,
        streakActual: true,
        streakMejor: true,
        streakUltimoCheck: true,
        createdAt: true,
        guiasVistas: true,
      },
    })

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    // Avatar vigente de Authoriza: si se cambió en otra app, se refleja al
    // abrir Kiri. Si Authoriza no responde se usa la copia local.
    const avatarActual = await getAuthorizaAvatar(user.correo)
    if (avatarActual && avatarActual !== user.avatarUrl) {
      await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: avatarActual } }).catch(() => {})
      user.avatarUrl = avatarActual
    }

    // Cuentas sin el nombre en partes: se traen de Authoriza (donde sí están
    // separadas) y se guardan; si Authoriza no responde, la mejor suposición.
    if (!user.primerNombre) {
      const na = await getAuthorizaName(user.correo)
      const partes = na?.firstName && na.firstSurname
        ? { primerNombre: na.firstName, segundoNombre: na.secondName ?? '', primerApellido: na.firstSurname, segundoApellido: na.secondSurname ?? '' }
        : partirNombre(user.nombre)
      // Solo se guarda lo que viene de Authoriza (la suposición no se fija)
      if (na?.firstName && na.firstSurname && unirNombre(partes).toLowerCase() === user.nombre.trim().toLowerCase()) {
        await prisma.user.update({
          where: { id: user.id },
          data: { primerNombre: partes.primerNombre, segundoNombre: partes.segundoNombre || null, primerApellido: partes.primerApellido, segundoApellido: partes.segundoApellido || null },
        }).catch(() => {})
      }
      Object.assign(user, { primerNombre: partes.primerNombre, segundoNombre: partes.segundoNombre || null, primerApellido: partes.primerApellido, segundoApellido: partes.segundoApellido || null })
    }

    // Autosanar cuentas viejas sin @username (de antes de que existiera esta
    // generación, o creadas por un flujo que no pasó por /auth/register).
    if (!user.username) {
      const username = await generateUniqueUsername(user.nombre)
      await prisma.user.update({ where: { id: user.id }, data: { username } })
      user.username = username
    }

    // Ingresos variables: el promedio real con el que Kiri planea si no hay estimación
    const ingresoPromedio = user.tipoIngreso === 'variable' ? await ingresoPromedioMensual(user.id) : null

    res.json({ user: { ...user, ingresoPromedio } })
  } catch (error) {
    console.error('[Me]', error)
    res.status(500).json({ error: 'Error al obtener perfil' })
  }
})

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Genera un token de reset y envía el enlace por correo — antes el token se
// generaba y se guardaba pero NUNCA se enviaba nada (solo un console.log de
// desarrollo), así que "olvidé mi contraseña" no le llegaba nada al usuario.

const forgotPasswordSchema = z.object({
  correo: z.string().email('Correo electrónico inválido'),
})

// ─── Términos y autorización de datos ─────────────────────────────────────────

/** ¿Debe aceptar (de nuevo) los documentos? Lo consulta la app al entrar. */
router.get('/consentimiento', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { terminosVersion: true, datosVersion: true, consentimientoAt: true },
  })
  if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
  res.json({
    pendiente: consentimientoPendiente(user),
    vigentes: LEGAL_VERSIONS,
    aceptadas: { terms: user.terminosVersion, habeasData: user.datosVersion, fecha: user.consentimientoAt },
  })
})

/** Aceptar las versiones vigentes (cuentas anteriores o cuando cambia el texto). */
router.post('/consentimiento', authMiddleware, validate(consentimientoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!aceptaVersionesVigentes(req.body)) {
      res.status(409).json({ error: 'Los documentos se actualizaron. Recarga la página y acéptalos de nuevo.', code: 'LEGAL_VERSION' })
      return
    }
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { id: true, correo: true } })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    // Primero la prueba legal en Authoriza; sin ella no se marca como aceptado
    const r = await fetch(`${env.AUTHORIZA_API_URL}/api/auth/internal/consents`, {
      method: 'POST',
      headers: authorizaInternalHeaders(),
      body: JSON.stringify({ email: user.correo, application: 'Kiri', source: 'KIRI_ACCEPT', ...consentPayload(req) }),
    }).catch(() => null)
    if (!r || !r.ok) {
      console.warn('[Consentimiento] Authoriza no registró la aceptación:', r?.status)
      res.status(503).json({ error: 'No pudimos registrar tu aceptación en este momento. Intenta de nuevo.' })
      return
    }
    await prisma.user.update({ where: { id: user.id }, data: consentLocalData() })
    res.json({ ok: true })
  } catch (error) {
    console.error('[Consentimiento]', error)
    res.status(500).json({ error: 'No se pudo registrar la aceptación.' })
  }
})

router.post('/forgot-password', validate(forgotPasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { correo } = req.body as { correo: string }

    const user = await prisma.user.findUnique({ where: { correo } })
    if (!user) {
      // No revelar si el usuario existe o no (seguridad)
      res.json({ message: 'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.' })
      return
    }

    // Generar token de reset (válido por 1 hora)
    const resetToken = crypto.randomBytes(32).toString('hex')
    const resetExpiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hora

    // Guardar token hasheado en un refresh token temporal (reutilizamos la tabla)
    const hashedToken = await bcrypt.hash(resetToken, 10)
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: hashedToken,
        expiresAt: resetExpiry,
      },
    })

    const resetLink = `${env.FRONTEND_URL.split(',')[0].trim()}/reset-password?token=${resetToken}&email=${encodeURIComponent(correo)}`
    const html = `
      <h2>Restablecer tu contraseña — Kiri Finance</h2>
      <p>Hola${user.nombre ? ` ${user.nombre}` : ''},</p>
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el siguiente enlace para elegir una nueva:</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
      <p>Este enlace vence en 1 hora. Si no fuiste tú quien lo solicitó, puedes ignorar este correo — tu contraseña seguirá siendo la misma.</p>
    `
    const sent = await sendMail({ to: correo, subject: 'Restablece tu contraseña — Kiri Finance', html })
    if (!sent) console.warn(`[ForgotPassword] No se pudo enviar el correo a ${correo} (SMTP no configurado o falló el envío)`)

    res.json({ message: 'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.' })
  } catch (error) {
    console.error('[ForgotPassword]', error)
    res.status(500).json({ error: 'Error al procesar la solicitud' })
  }
})

// ─── POST /auth/reset-password ────────────────────────────────────────────────
// Consume el token enviado por correo y fija la nueva contraseña. Antes NO
// existía ningún endpoint que validara ese token — se generaba y se guardaba
// hasheado, pero nada en la API podía usarlo nunca para completar el reset.

const resetPasswordSchema = z.object({
  correo: z.string().email('Correo electrónico inválido'),
  token: z.string().min(1, 'Token requerido'),
  newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres'),
})

router.post('/reset-password', validate(resetPasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { correo, token, newPassword } = req.body as { correo: string; token: string; newPassword: string }

    const user = await prisma.user.findUnique({ where: { correo } })
    if (!user) {
      res.status(400).json({ error: 'Enlace inválido o vencido.' })
      return
    }

    // Los tokens de reset se guardan hasheados en la misma tabla que los
    // refresh tokens normales (que sí van en texto plano) — no se puede
    // buscar por igualdad directa, hay que comparar contra cada candidato
    // vigente de este usuario hasta encontrar el que hace match.
    const candidates = await prisma.refreshToken.findMany({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    })

    let matched: (typeof candidates)[number] | null = null
    for (const candidate of candidates) {
      try {
        if (await bcrypt.compare(token, candidate.token)) { matched = candidate; break }
      } catch { /* fila no es un hash bcrypt (ej. un refresh token normal en texto plano) — seguir */ }
    }

    if (!matched) {
      res.status(400).json({ error: 'Enlace inválido o vencido. Solicita uno nuevo.' })
      return
    }

    // La contraseña se fija en Authoriza (única fuente). Si falla, el token NO
    // se consume: el usuario puede reintentar con el mismo enlace.
    try {
      try {
        await setAuthorizaPassword(correo, newPassword)
      } catch (err) {
        // Cuenta antigua que solo existía en Kiri: el token enviado a su correo
        // prueba que es suya, así que se crea en Authoriza con la nueva contraseña.
        if (err instanceof AuthorizaRejectedError && err.status === 404) {
          await ensureAuthorizaAccount(correo, newPassword, user.nombre)
        } else {
          throw err
        }
      }
    } catch (err) {
      if (err instanceof AuthorizaRejectedError) {
        res.status(400).json({ error: err.message })
        return
      }
      console.warn('[ResetPassword] Authoriza no disponible:', (err as Error).message)
      res.status(503).json({ error: 'No pudimos actualizar tu contraseña en este momento. Intenta de nuevo en unos minutos.' })
      return
    }

    await prisma.$transaction([
      // Cierra también los access tokens ya emitidos (ver middleware/auth.ts)
      prisma.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }),
      // Invalidar el token de reset usado y cualquier sesión activa — igual
      // que un cambio de contraseña normal, para que un enlace viejo o una
      // sesión robada no sigan sirviendo después del reset.
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ])

    res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' })
  } catch (error) {
    console.error('[ResetPassword]', error)
    res.status(500).json({ error: 'Error al restablecer la contraseña' })
  }
})

// ─── POST /auth/check-email ───────────────────────────────────────────────────
// Public endpoint used by the landing page to verify if a Kiri user exists.

router.post('/check-email', async (req: Request, res: Response): Promise<void> => {
  try {
    const { correo } = req.body
    if (!correo) {
      res.json({ exists: false })
      return
    }

    const user = await prisma.user.findUnique({ where: { correo } })
    res.json({ exists: !!user })
  } catch (error) {
    console.error('[CheckEmail]', error)
    res.json({ exists: false })
  }
})

// ─── POST /auth/change-password ───────────────────────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
  newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres'),
})

router.post('/change-password', authMiddleware, validate(changePasswordSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = req.body
    const userId = req.user!.userId

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    // Authoriza valida la actual y fija la nueva (única fuente de la contraseña)
    try {
      await setAuthorizaPassword(user.correo, newPassword, currentPassword)
    } catch (err) {
      if (err instanceof AuthorizaRejectedError) {
        res.status(err.status === 401 ? 401 : 400).json({ error: err.message })
        return
      }
      console.warn('[ChangePassword] Authoriza no disponible:', (err as Error).message)
      res.status(503).json({ error: 'No pudimos actualizar tu contraseña en este momento. Intenta de nuevo en unos minutos.' })
      return
    }

    res.json({ message: 'Contraseña actualizada exitosamente.' })
  } catch (error) {
    console.error('[ChangePassword]', error)
    res.status(500).json({ error: 'Error al cambiar la contraseña' })
  }
})

export default router
