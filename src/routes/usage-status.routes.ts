/**
 * Rutas de estado de uso y límites del paquete.
 * Permite al frontend mostrar el consumo actual vs. los límites del plan.
 */
import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { prisma } from '../config/database.js'
import {
  fetchTenantLimits,
  fetchKiriLimits,
  invalidateTenantCache,
  AuthorizaError,
} from '../lib/authoriza-client.js'
import { KIRI_VARIABLE_MAP, KIRI_VARIABLE_DISPLAY } from '../middleware/limit-enforcement.js'

const router = Router()

// ─── GET /usage-status — Estado completo de uso ───────────────────────────────

router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.user?.tenantId

    if (!tenantId) {
      // Usuario standalone (token Kiri), no tiene límites de paquete
      res.json({
        tenantId: null,
        packageName: 'Standalone',
        isBillable: false,
        variables: [],
        message: 'Este usuario no está vinculado a un contrato Cyclonet.',
      })
      return
    }

    const limitsResponse = await fetchTenantLimits(tenantId)
    const kiriLimits = limitsResponse.limits.filter(l => l.targetApplication === 'Kiri')

    // Contar uso actual para cada variable
    const userId = req.user!.userId
    const variables = await Promise.all(
      kiriLimits.map(async (limit) => {
        const resource = KIRI_VARIABLE_MAP[limit.variableName]
        let currentCount = 0

        if (resource) {
          currentCount = await countResourceForStatus(resource, userId)
        }

        const usagePercentage = limit.maxValue > 0
          ? Math.round((currentCount / limit.maxValue) * 100)
          : 0

        return {
          variableName: limit.variableName,
          displayName: limit.displayName || KIRI_VARIABLE_DISPLAY[limit.variableName] || limit.variableName,
          maxValue: limit.maxValue,
          currentCount,
          usagePercentage,
        }
      })
    )

    res.json({
      tenantId,
      packageName: limitsResponse.packageName,
      isBillable: limitsResponse.isBillable,
      startDate: limitsResponse.startDate,
      endDate: limitsResponse.endDate,
      variables,
    })
  } catch (error) {
    if (error instanceof AuthorizaError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message })
      return
    }
    console.error('[UsageStatus]', error)
    res.status(500).json({ error: 'Error al obtener estado de uso' })
  }
})

// ─── GET /usage-status/warnings — Variables que superan el 80% ────────────────

router.get('/warnings', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.user?.tenantId

    if (!tenantId) {
      res.json({ warnings: [] })
      return
    }

    const kiriLimits = await fetchKiriLimits(tenantId)
    const userId = req.user!.userId
    const warnings: any[] = []

    for (const limit of kiriLimits) {
      const resource = KIRI_VARIABLE_MAP[limit.variableName]
      if (!resource) continue

      const currentCount = await countResourceForStatus(resource, userId)
      const percentage = limit.maxValue > 0
        ? Math.round((currentCount / limit.maxValue) * 100)
        : 0

      if (percentage >= 80) {
        warnings.push({
          variableName: limit.variableName,
          displayName: limit.displayName || KIRI_VARIABLE_DISPLAY[limit.variableName],
          currentCount,
          maxValue: limit.maxValue,
          percentage,
          message: percentage >= 100
            ? `Has alcanzado el límite de ${limit.displayName || KIRI_VARIABLE_DISPLAY[limit.variableName]}`
            : `Estás cerca del límite de ${limit.displayName || KIRI_VARIABLE_DISPLAY[limit.variableName]} (${percentage}%)`,
        })
      }
    }

    res.json({ warnings })
  } catch (error) {
    if (error instanceof AuthorizaError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message })
      return
    }
    console.error('[UsageWarnings]', error)
    res.status(500).json({ error: 'Error al obtener advertencias de uso' })
  }
})

// ─── POST /usage-status/invalidate-cache/:tenantId — Webhook de Authoriza ─────

router.post('/invalidate-cache/:tenantId', async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.params.tenantId as string
  invalidateTenantCache(tenantId)
  res.json({ success: true, message: `Cache invalidada para tenant ${tenantId}` })
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function countResourceForStatus(resource: string, userId: string): Promise<number> {
  switch (resource) {
    case 'debts':
      return prisma.debt.count({ where: { userId, estado: 'activa' } })
    case 'fixed-expenses':
      return prisma.fixedExpense.count({ where: { userId } })
    case 'extra-incomes':
      return prisma.extraIncome.count({ where: { userId } })
    case 'shared-pockets':
      return prisma.sharedPocketMember.count({ where: { userId } })
    case 'loans':
      return prisma.loan.count({
        where: {
          OR: [
            { lenderId: userId, status: { in: ['ACTIVE', 'PENDING_APPROVAL', 'PENDING_BORROWER_CONFIRMATION'] } },
            { borrowerId: userId, status: { in: ['ACTIVE', 'PENDING_APPROVAL', 'PENDING_BORROWER_CONFIRMATION'] } },
          ],
        },
      })
    case 'connections':
      return prisma.connection.count({
        where: {
          OR: [
            { requesterId: userId, status: 'ACCEPTED' },
            { addresseeId: userId, status: 'ACCEPTED' },
          ],
        },
      })
    default:
      return 0
  }
}

export default router
