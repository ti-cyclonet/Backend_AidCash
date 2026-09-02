import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { env } from '../config/env.js'
import { validate } from '../middleware/validate.js'
import { authMiddleware, AuthPayload } from '../middleware/auth.js'
import { generateUniqueUsername } from '../lib/username.js'
import crypto from 'crypto'

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
    const { nombre, correo, password, documentType, documentNumber, firstName, secondName, firstSurname, secondSurname } = req.body

    // Verificar si el correo ya existe
    const existing = await prisma.user.findUnique({ where: { correo } })
    if (existing) {
      res.status(409).json({ error: 'Este correo ya está registrado.' })
      return
    }

    // Hashear contraseña
    const passwordHash = await bcrypt.hash(password, 12)

    // @username público (Social) — se autogenera del nombre, editable después
    const username = await generateUniqueUsername(nombre)

    // Crear usuario local INACTIVO (pendiente de verificación de correo)
    const user = await prisma.user.create({
      data: {
        nombre,
        correo,
        username,
        passwordHash,
        isActive: false, // Inactivo hasta verificar el correo
        frecuenciaIngreso: 'mensual',
        ingresoBase: 0,
        onboardingDone: false,
        metaAhorroGlobal: 5000,
        saldoAhorroTotal: 0,
        fondoEmergenciaActual: 0,
      },
    })

    // Registrar en Authoriza con verificación de correo
    let verificationRequired = true
    try {
      const authorizaUrl = env.AUTHORIZA_API_URL || 'http://localhost:3000'
      const authRes = await fetch(`${authorizaUrl}/api/auth/register-kiri`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      const authData = await authRes.json() as any
      // If user already existed in Authoriza (verified), activate locally
      if (authData.alreadyExists) {
        verificationRequired = false
        await prisma.user.update({ where: { id: user.id }, data: { isActive: true } })
      }
    } catch (authErr) {
      console.warn('[Register] Failed to register in Authoriza:', (authErr as Error).message)
    }

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
    const { correo, password } = req.body

    const user = await prisma.user.findUnique({ where: { correo } })
    if (!user) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos.' })
      return
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos.' })
      return
    }

    // Verificar estado en Authoriza (fuente de verdad del control de acceso)
    try {
      const authorizaUrl = env.AUTHORIZA_API_URL || 'http://localhost:3000'
      const statusRes = await fetch(`${authorizaUrl}/api/auth/user-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: correo }),
      })
      if (statusRes.ok) {
        const statusData = await statusRes.json() as any
        // Only enforce if the user exists in Authoriza
        if (statusData.exists && !statusData.allowed) {
          // Sync local isActive flag to match Authoriza
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
            error: messages[statusData.reason] || 'Tu acceso ha sido restringido. Contacta al administrador.',
            code: 'ACCESS_DENIED',
            reason: statusData.reason,
          })
          return
        }
        // If Authoriza allows and local was inactive, reactivate locally
        if (statusData.exists && statusData.allowed && user.isActive === false) {
          await prisma.user.update({ where: { id: user.id }, data: { isActive: true } }).catch(() => {})
          user.isActive = true
        }
      }
    } catch (statusErr) {
      // If Authoriza is unreachable, fall back to local isActive check (fail-safe)
      console.warn('[Login] Could not verify status in Authoriza:', (statusErr as Error).message)
    }

    // Verificar que el usuario esté activo localmente (fallback)
    if (user.isActive === false) {
      res.status(403).json({
        error: 'Tu cuenta está temporalmente suspendida. Recibirás un correo cuando sea reactivada.',
        code: 'ACCOUNT_SUSPENDED',
      })
      return
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
      },
      accessToken,
      refreshToken,
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
        ingresoBase: true,
        frecuenciaIngreso: true,
        diasPago: true,
        onboardingDone: true,
        metaAhorroGlobal: true,
        saldoAhorroTotal: true,
        fondoEmergenciaActual: true,
        streakActual: true,
        streakMejor: true,
        streakUltimoCheck: true,
        createdAt: true,
      },
    })

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    // Autosanar cuentas viejas sin @username (de antes de que existiera esta
    // generación, o creadas por un flujo que no pasó por /auth/register).
    if (!user.username) {
      const username = await generateUniqueUsername(user.nombre)
      await prisma.user.update({ where: { id: user.id }, data: { username } })
      user.username = username
    }

    res.json({ user })
  } catch (error) {
    console.error('[Me]', error)
    res.status(500).json({ error: 'Error al obtener perfil' })
  }
})

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Envía un correo con un token para restablecer la contraseña.
// Por ahora genera el token y lo guarda. La integración con un servicio de email
// (SendGrid, Resend, etc.) se puede añadir después.

const forgotPasswordSchema = z.object({
  correo: z.string().email('Correo electrónico inválido'),
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

    // TODO: Integrar con servicio de email (SendGrid, Resend, Nodemailer)
    // Por ahora, logueamos el link de reset para desarrollo
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}&email=${correo}`
    console.log(`[ForgotPassword] Reset link for ${correo}: ${resetLink}`)

    res.json({ message: 'Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.' })
  } catch (error) {
    console.error('[ForgotPassword]', error)
    res.status(500).json({ error: 'Error al procesar la solicitud' })
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

    // Validate current password
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash)
    if (!isValid) {
      res.status(401).json({ error: 'La contraseña actual es incorrecta.' })
      return
    }

    // Prevent reusing the same password
    const isSame = await bcrypt.compare(newPassword, user.passwordHash)
    if (isSame) {
      res.status(400).json({ error: 'La nueva contraseña debe ser diferente a la actual.' })
      return
    }

    // Hash and update
    const newHash = await bcrypt.hash(newPassword, 12)
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    })

    res.json({ message: 'Contraseña actualizada exitosamente.' })
  } catch (error) {
    console.error('[ChangePassword]', error)
    res.status(500).json({ error: 'Error al cambiar la contraseña' })
  }
})

export default router
