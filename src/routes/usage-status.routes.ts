/**
 * Rutas de estado de uso y límites del plan (KIRI FREE / PLUS / PRO).
 * Mi plan las usa para "Tu uso este mes": lo que llevas frente al tope de tu plan.
 */
import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { invalidateTenantCache } from '../lib/authoriza-client.js'
import { KIRI_VARIABLE_MAP, countResource, periodoIA } from '../middleware/limit-enforcement.js'
import { prisma } from '../config/database.js'
import { ILIMITADO, resolverPlan } from '../lib/planes.js'
import { bonosIA } from '../lib/referidos.js'

const router = Router()

// Cuotas de IA: los usos extra ganados (invitar amigos) se muestran sumados
// al tope del plan — "12 de 50", no "0 de 10" (countResource ya los descuenta)
const TIPO_IA: Record<string, 'coach' | 'dictado' | 'escaneo'> = { iaMensajesMes: 'coach', iaDictadosMes: 'dictado', iaEscaneosMes: 'escaneo' }

async function usoDelPlan(userId: string) {
  const plan = await resolverPlan(userId)
  const extras = await bonosIA(userId)
  const variables = await Promise.all(
    Object.entries(plan.limites)
      .filter(([k]) => KIRI_VARIABLE_MAP[k])
      .map(async ([variableName, lim]) => {
        const ilimitado = lim.maxValue >= ILIMITADO
        const tipoIA = TIPO_IA[variableName]
        const extra = tipoIA && !ilimitado ? extras[tipoIA] : 0
        const currentCount = tipoIA
          ? (await prisma.aiUso.findUnique({ where: { userId_periodo_tipo: { userId, periodo: periodoIA(), tipo: tipoIA } } }))?.cantidad ?? 0
          : await countResource(KIRI_VARIABLE_MAP[variableName], userId)
        const maxValue = lim.maxValue + extra
        return {
          variableName,
          displayName: lim.displayName,
          maxValue,
          ilimitado,
          currentCount,
          ...(extra ? { extra } : {}),
          usagePercentage: ilimitado || maxValue <= 0 ? 0 : Math.min(100, Math.round((currentCount / maxValue) * 100)),
        }
      }),
  )
  return { plan, variables }
}

// ─── GET /usage-status — uso actual frente al plan ────────────────────────────

router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { plan, variables } = await usoDelPlan(req.user!.userId)
    res.json({ packageName: plan.planName, tier: plan.tier, fuente: plan.fuente, isBillable: plan.isBillable ?? false, variables })
  } catch (error) {
    console.error('[UsageStatus]', error)
    res.status(500).json({ error: 'Error al obtener estado de uso' })
  }
})

// ─── GET /usage-status/warnings — lo que va en 80% o más ──────────────────────

router.get('/warnings', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { variables } = await usoDelPlan(req.user!.userId)
    res.json({ warnings: variables.filter(v => !v.ilimitado && v.maxValue > 0 && v.usagePercentage >= 80) })
  } catch (error) {
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

export default router
