import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import { authMiddleware } from '../middleware/auth.js'
import { env } from '../config/env.js'
import { prisma } from '../config/database.js'

const router = Router()

interface PlanLimit {
  variableName: string
  displayName: string
  maxValue: number
  targetApplication: string
  limitType: string
}

interface TenantLimitsResponse {
  contractId: string
  packageName: string
  isBillable: boolean
  startDate: string | null
  endDate: string | null
  limits: PlanLimit[]
}

/**
 * GET /api/plan
 * Returns the current user's plan features from Authoriza.
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.correo

    if (!userEmail) {
      return res.json({ planName: 'Sin plan', features: {}, limits: {}, hasPlan: false })
    }

    // First, find the user in Authoriza by email to get their Authoriza userId
    const checkUrl = `${env.AUTHORIZA_API_URL}/api/auth/check-email`
    const checkRes = await fetch(checkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail }),
    })

    if (!checkRes.ok) {
      return res.json({ planName: 'Sin plan', features: {}, limits: {}, hasPlan: false })
    }

    const checkData = await checkRes.json() as any
    if (!checkData.exists || !checkData.userId) {
      return res.json({ planName: 'Sin plan', features: {}, limits: {}, hasPlan: false })
    }

    const authorizaUserId = checkData.userId
    const url = `${env.AUTHORIZA_API_URL}/api/contracts/tenant/${authorizaUserId}/limits?application=Kiri`
    const response = await fetch(url)

    if (!response.ok) {
      // If no contract found, return a "no plan" response
      if (response.status === 404) {
        return res.json({
          planName: 'Sin plan',
          features: {},
          limits: {},
          hasPlan: false,
        })
      }
      throw new Error(`Authoriza responded with status ${response.status}`)
    }

    const data = await response.json() as TenantLimitsResponse

    // Filter only Kiri limits
    const kiriLimits = data.limits.filter(
      (l) => l.targetApplication.toLowerCase() === 'kiri'
    )

    // Separate features from quantity limits
    const features: Record<string, boolean> = {}
    const quantityLimits: Record<string, { displayName: string; maxValue: number }> = {}

    for (const limit of kiriLimits) {
      if (limit.limitType === 'feature') {
        features[limit.variableName] = limit.maxValue === 1
      } else {
        quantityLimits[limit.variableName] = {
          displayName: limit.displayName,
          maxValue: limit.maxValue,
        }
      }
    }

    return res.json({
      planName: data.packageName,
      contractId: data.contractId,
      isBillable: data.isBillable,
      features,
      limits: quantityLimits,
      hasPlan: true,
    })
  } catch (error: any) {
    console.error('[Plan] Error fetching plan:', error.message)
    return res.status(503).json({
      error: 'No se pudo obtener la información del plan. Intente más tarde.',
    })
  }
})

/**
 * GET /api/plan/available
 * Returns the available plans for upgrade (public landing data from Authoriza).
 */
router.get('/available', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const url = `${env.AUTHORIZA_API_URL}/api/packages/landing?application=Kiri`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Authoriza responded with status ${response.status}`)
    }

    const plans = await response.json()
    return res.json(plans)
  } catch (error: any) {
    console.error('[Plan] Error fetching available plans:', error.message)
    return res.status(503).json({
      error: 'No se pudieron obtener los planes disponibles.',
    })
  }
})

/**
 * POST /api/plan/upgrade
 * Self-service plan change. Validates password and upgrades the user's plan
 * in Authoriza. This triggers contract generation, adminInvoices role assignment,
 * and marks the user as Firmante (authorized signer).
 */
router.post('/upgrade', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.correo
    const { packageId, password } = req.body

    if (!packageId || !password) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere packageId y password.',
      })
    }

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        error: 'No se pudo identificar tu cuenta. Intenta iniciar sesión de nuevo.',
      })
    }

    // Call Authoriza's upgrade-plan endpoint
    const upgradeUrl = `${env.AUTHORIZA_API_URL}/api/auth/upgrade-plan`
    const upgradeResponse = await fetch(upgradeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userEmail,
        password,
        packageId,
      }),
    })

    const upgradeData = await upgradeResponse.json() as any

    if (!upgradeResponse.ok) {
      return res.status(upgradeResponse.status).json({
        success: false,
        error: upgradeData.message || 'Error al cambiar de plan.',
      })
    }

    // User keeps access to Kiri while contract is pending approval.
    // Access will upgrade automatically when the contract is signed and activated.
    // NOTE: We do NOT deactivate the user here — they keep using the previous plan
    // until the new contract is fully signed and activated by Authoriza's webhook.

    return res.json({
      success: true,
      message: upgradeData.message || 'Plan actualizado exitosamente.',
    })
  } catch (error: any) {
    console.error('[Plan] Error upgrading plan:', error.message)
    return res.status(500).json({
      success: false,
      error: 'Error al procesar el cambio de plan. Intente más tarde.',
    })
  }
})

/**
 * POST /api/plan/upgrade-from-landing
 * Called from the landing page for users who exist in Kiri but NOT in Authoriza.
 * Validates password locally, creates the user in Authoriza if needed, then upgrades.
 */
router.post('/upgrade-from-landing', async (req: Request, res: Response) => {
  try {
    const { email, password, packageId } = req.body

    if (!email || !password || !packageId) {
      return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' })
    }

    // 1. Validate user exists locally and password is correct
    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado.' })
    }

    const isValid = await bcrypt.compare(password, user.passwordHash)
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta.' })
    }

    // 2. Register user in Authoriza (self-register with same email/password)
    //    Then call upgrade-plan
    const registerUrl = `${env.AUTHORIZA_API_URL}/api/auth/ensure-kiri-user`
    const registerRes = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, nombre: user.nombre }),
    })

    // If user already exists in Authoriza or was just created, proceed with upgrade
    if (registerRes.ok || registerRes.status === 409) {
      // Call upgrade-plan
      const upgradeUrl = `${env.AUTHORIZA_API_URL}/api/auth/upgrade-plan`
      const upgradeRes = await fetch(upgradeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, packageId }),
      })
      const upgradeData = await upgradeRes.json() as any

      if (upgradeRes.ok && upgradeData.success) {
        // User keeps access while contract is pending — do NOT deactivate
        return res.json({ success: true, message: upgradeData.message })
      }

      return res.status(upgradeRes.status).json({
        success: false,
        error: upgradeData.message || 'Error al procesar el cambio de plan.',
      })
    }

    return res.status(500).json({
      success: false,
      error: 'No se pudo preparar tu cuenta para el cambio de plan. Contacta soporte.',
    })
  } catch (error: any) {
    console.error('[Plan] Error in upgrade-from-landing:', error.message)
    return res.status(500).json({ success: false, error: 'Error al procesar el cambio de plan.' })
  }
})

/**
 * POST /api/plan/activate-user
 * Webhook called by Authoriza when a Kiri contract is activated.
 * Reactivates the local user so they can access the app again.
 * This is a server-to-server call (no auth required).
 */
router.post('/activate-user', async (req: Request, res: Response) => {
  try {
    const { email, contractId, planUpgraded, packageName } = req.body

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in Kiri.' })
    }

    // Set welcome flag for paid plan upgrade (shown as in-app notification)
    const welcomeFlag = planUpgraded ? (packageName || 'Kiri Plus') : null

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: true,
        ...(welcomeFlag ? { pendingWelcome: welcomeFlag } : {}),
      },
    })

    console.log(`[Plan] User ${user.correo} activated (contract ${contractId || 'N/A'})${planUpgraded ? ' — plan upgraded to ' + welcomeFlag : ''}`)

    return res.json({ success: true, message: 'User activated successfully.' })
  } catch (error: any) {
    console.error('[Plan] Error activating user:', error.message)
    return res.status(500).json({ success: false, error: 'Error activating user.' })
  }
})

/**
 * GET /api/plan/welcome — check and clear pending welcome notification
 * Returns { pendingWelcome: string | null } and clears the flag once read.
 */
router.get('/welcome', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId
    if (!userId) {
      return res.status(401).json({ pendingWelcome: null })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const pending = user?.pendingWelcome || null

    // Clear the flag once read
    if (pending) {
      await prisma.user.update({ where: { id: userId }, data: { pendingWelcome: null } })
    }

    return res.json({ pendingWelcome: pending })
  } catch (error: any) {
    console.error('[Plan] Error checking welcome:', error.message)
    return res.json({ pendingWelcome: null })
  }
})

/**
 * POST /api/plan/set-user-status
 * Webhook called by Authoriza when a user's status changes (block/unblock).
 * Authoriza is the source of truth for access control.
 * Server-to-server call (no auth required).
 * Body: { email, allowed: boolean }
 */
router.post('/set-user-status', async (req: Request, res: Response) => {
  try {
    const { email, allowed } = req.body

    if (!email || typeof allowed !== 'boolean') {
      return res.status(400).json({ success: false, error: 'email and allowed (boolean) are required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in Kiri.' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: allowed },
    })

    // If blocking, revoke all active refresh tokens to force logout
    if (!allowed) {
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } }).catch(() => {})
    }

    console.log(`[Plan] User ${user.correo} status updated: isActive=${allowed}`)
    return res.json({ success: true, message: `User access ${allowed ? 'enabled' : 'disabled'}.` })
  } catch (error: any) {
    console.error('[Plan] Error setting user status:', error.message)
    return res.status(500).json({ success: false, error: 'Error updating user status.' })
  }
})

export default router
