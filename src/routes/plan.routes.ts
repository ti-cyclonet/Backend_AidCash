import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { env } from '../config/env.js'

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

export default router
