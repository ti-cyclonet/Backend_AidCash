/**
 * Límites y funciones por plan (KIRI FREE / PLUS / PRO).
 *
 * - checkLimit('nCategorias'): antes de crear algo, ¿le cabe en su plan?
 * - requireFeature('p2pLoans'): ¿su plan incluye esta función?
 *
 * El plan sale de resolverPlan() (lib/planes.ts), que busca el contrato por
 * correo — antes solo se revisaba con tokens de Authoriza (tenantId) y quien
 * entraba por el login de Kiri no tenía ningún límite.
 *
 * Las respuestas 403 traen `codigo` y `mejora` para que el frontend muestre
 * "Llegaste a tus 5 categorías. Con KIRI PLUS tienes 20" con el botón a Mi plan.
 */
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database.js'
import { ILIMITADO, MATRIZ, mejoraPara, resolverPlan, type PlanResuelto } from '../lib/planes.js'

/** Variable de cantidad → recurso que se cuenta */
export const KIRI_VARIABLE_MAP: Record<string, string> = {
  nCategorias: 'categories',
  nDeudas: 'debts',
  nGastosFijos: 'fixed-expenses',
  nBolsillos: 'pockets',
  nMeDeben: 'external-loans',
  nIngresosExtra: 'extra-incomes',
  nBolsillosCompartidos: 'shared-pockets',
  nPrestamos: 'loans',
  nConexiones: 'connections',
  iaMensajesMes: 'ia-coach',
  iaDictadosMes: 'ia-dictado',
  iaEscaneosMes: 'ia-escaneo',
}

export const KIRI_VARIABLE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(MATRIZ).map(([k, v]) => [k, v.displayName]),
)

export const periodoIA = (now: Date = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

export async function countResource(resource: string, userId: string): Promise<number> {
  switch (resource) {
    case 'categories':
      return prisma.budgetCategory.count({ where: { userId } })
    case 'debts':
      return prisma.debt.count({ where: { userId, estado: 'activa' } })
    case 'fixed-expenses':
      return prisma.fixedExpense.count({ where: { userId } })
    case 'pockets':
      return prisma.savingsPocket.count({ where: { userId } })
    case 'external-loans':
      return prisma.externalLoan.count({ where: { userId, estado: 'activo' } })
    case 'extra-incomes':
      return prisma.extraIncome.count({ where: { userId } })
    case 'shared-pockets':
      return prisma.sharedPocketMember.count({ where: { userId } })
    case 'loans':
      return prisma.loan.count({
        where: {
          OR: [{ lenderId: userId }, { borrowerId: userId }],
          status: { in: ['ACTIVE', 'PENDING_APPROVAL', 'PENDING_BORROWER_CONFIRMATION'] },
        },
      })
    case 'connections':
      return prisma.connection.count({
        where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] },
      })
    case 'ia-coach':
    case 'ia-dictado':
    case 'ia-escaneo': {
      const tipo = resource.slice(3)
      const r = await prisma.aiUso.findUnique({ where: { userId_periodo_tipo: { userId, periodo: periodoIA(), tipo } } })
      return r?.cantidad ?? 0
    }
    default:
      return 0
  }
}

/** Mensaje y datos de "llegaste al límite" para una variable de cantidad. */
export function respuestaLimite(plan: PlanResuelto, variableName: string, currentCount: number) {
  const lim = plan.limites[variableName]
  const nombre = lim?.displayName ?? KIRI_VARIABLE_DISPLAY[variableName] ?? variableName
  const maxValue = lim?.maxValue ?? 0
  const mejora = mejoraPara(variableName, plan.tier)
  const mejoraTxt = mejora
    ? mejora.maxValue >= ILIMITADO ? `Con ${mejora.plan} no tienes límite.` : `Con ${mejora.plan} tienes ${mejora.maxValue}.`
    : ''
  const message = maxValue <= 0
    ? `Tu plan no incluye ${nombre}. ${mejora ? `Está incluido desde ${mejora.plan}.` : ''}`.trim()
    : `Llegaste a tus ${maxValue} ${nombre} de ${plan.planName}. ${mejoraTxt}`.trim()
  return { error: 'LIMIT_REACHED', codigo: 'LIMITE', message, variableName, currentCount, maxValue, plan: plan.planName, mejora }
}

/** ¿Le cabe uno más de este recurso en su plan? */
export function checkLimit(variableName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId
      if (!userId) { next(); return }
      const plan = await resolverPlan(userId)
      // Authoriza caído y sin nada guardado: no bloquear a nadie por eso
      if (plan.fuente === 'sin_conexion') { next(); return }
      const max = plan.limites[variableName]?.maxValue
      const resource = KIRI_VARIABLE_MAP[variableName]
      if (max == null || max >= ILIMITADO || !resource) { next(); return }

      const currentCount = await countResource(resource, userId)
      if (currentCount >= max) {
        res.status(403).json(respuestaLimite(plan, variableName, currentCount))
        return
      }
      if (max > 0 && currentCount / max >= 0.8) {
        ;(req as any)._usageWarning = {
          variableName, currentCount, maxValue: max,
          displayName: plan.limites[variableName]?.displayName,
          message: `Vas en ${currentCount} de ${max} ${plan.limites[variableName]?.displayName ?? ''}`.trim(),
        }
      }
      next()
    } catch (error) {
      console.error('[checkLimit]', error)
      next() // nunca tumbar la creación por un error al revisar el plan
    }
  }
}

/** Respuesta estándar de "tu plan no incluye esta función". */
export function respuestaFuncion(plan: PlanResuelto, feature: string) {
  const def = MATRIZ[feature]
  const mejora = mejoraPara(feature, plan.tier)
  return {
    error: 'FEATURE_BLOCKED', codigo: 'FUNCION', feature,
    message: `«${def?.displayName ?? 'Esta función'}» ${mejora ? `es parte de ${mejora.plan}` : 'no está en tu plan'}.`,
    plan: plan.planName, mejora,
  }
}

/** ¿Su plan incluye esta función? */
export function requireFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId
      if (!userId) { next(); return }
      const plan = await resolverPlan(userId)
      if (plan.fuente === 'sin_conexion' || plan.features[feature]) { next(); return }
      res.status(403).json(respuestaFuncion(plan, feature))
    } catch (error) {
      console.error('[requireFeature]', error)
      next()
    }
  }
}

/** Helper que las rutas pueden usar para incluir el aviso de uso en la respuesta. */
export function attachUsageWarning(req: Request, data: any): any {
  const warning = (req as any)._usageWarning
  if (warning && data && typeof data === 'object') {
    return { ...data, _usageWarning: warning }
  }
  return data
}
