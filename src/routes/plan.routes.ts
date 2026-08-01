import { Router, Request, Response } from 'express'
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
    const userId = (req as any).userId

    const url = `${env.AUTHORIZA_API_URL}/api/contracts/tenant/${userId}/limits`
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

    const upgradeData = await upgradeResponse.json()

    if (!upgradeResponse.ok) {
      return res.status(upgradeResponse.status).json({
        success: false,
        error: upgradeData.message || 'Error al cambiar de plan.',
      })
    }

    // Deactivate local Kiri user while contract is pending approval
    const userId = (req as any).user?.userId
    if (userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { isActive: false },
      })
      console.log(`[Plan] User ${userId} deactivated locally (pending contract approval)`)
    }

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
 * POST /api/plan/activate-user
 * Webhook called by Authoriza when a Kiri contract is activated.
 * Reactivates the local user so they can access the app again.
 * This is a server-to-server call (no auth required).
 */
router.post('/activate-user', async (req: Request, res: Response) => {
  try {
    const { email, contractId } = req.body

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in Kiri.' })
    }

    if (user.isActive) {
      return res.json({ success: true, message: 'User is already active.' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: true },
    })

    console.log(`[Plan] User ${user.correo} reactivated (contract ${contractId || 'N/A'} approved)`)

    return res.json({ success: true, message: 'User reactivated successfully.' })
  } catch (error: any) {
    console.error('[Plan] Error reactivating user:', error.message)
    return res.status(500).json({ success: false, error: 'Error reactivating user.' })
  }
})

export default router
