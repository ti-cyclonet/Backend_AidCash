/**
 * Middleware de control de límites por paquete.
 * Consulta a Authoriza los límites del tenant y valida que el recurso
 * no haya excedido su cuota antes de permitir la creación.
 *
 * Patrón inspirado en Inout's LimitEnforcementGuard.
 */
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database.js'
import { fetchKiriLimits, AuthorizaError } from '../lib/authoriza-client.js'

// ─── Mapeo de variables de límite a conteos reales en BD ──────────────────────

/**
 * Mapeo de nombre de variable en Authoriza → modelo Prisma que se cuenta.
 * Estas son las variables que deben existir en los paquetes de Authoriza
 * con targetApplication = "Kiri".
 */
export const KIRI_VARIABLE_MAP: Record<string, string> = {
  nDeudas: 'debts',
  nGastosFijos: 'fixed-expenses',
  nIngresosExtra: 'extra-incomes',
  nBolsillosCompartidos: 'shared-pockets',
  nPrestamos: 'loans',
  nConexiones: 'connections',
}

export const KIRI_VARIABLE_DISPLAY: Record<string, string> = {
  nDeudas: 'Deudas',
  nGastosFijos: 'Gastos Fijos',
  nIngresosExtra: 'Ingresos Extra',
  nBolsillosCompartidos: 'Bolsillos Compartidos',
  nPrestamos: 'Préstamos',
  nConexiones: 'Conexiones',
}

// ─── Funciones de conteo por recurso ──────────────────────────────────────────

async function countResource(resource: string, userId: string): Promise<number> {
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

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Crea un middleware que valida si el usuario (tenant) tiene cuota disponible
 * para crear un nuevo recurso del tipo indicado.
 *
 * Si el usuario inició sesión con token de Kiri (sin tenantId), se aplica
 * sin restricción (usuario standalone, plan libre).
 *
 * @param variableName - Nombre de la variable de límite (ej: 'nDeudas')
 */
export function checkLimit(variableName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenantId = req.user?.tenantId

      // Si no hay tenantId (usuario con token Kiri propio), permitir sin restricción
      if (!tenantId) {
        next()
        return
      }

      const resource = KIRI_VARIABLE_MAP[variableName]
      if (!resource) {
        // Variable no mapeada, permitir
        next()
        return
      }

      // Obtener límites desde Authoriza
      const limits = await fetchKiriLimits(tenantId)
      const limitDef = limits.find(l => l.variableName === variableName)

      // Si no hay límite definido para esta variable, permitir
      if (!limitDef) {
        next()
        return
      }

      // Contar el uso actual
      const userId = req.user!.userId
      const currentCount = await countResource(resource, userId)

      if (currentCount >= limitDef.maxValue) {
        res.status(403).json({
          error: 'LIMIT_REACHED',
          message: `Has alcanzado el límite de ${limitDef.displayName || KIRI_VARIABLE_DISPLAY[variableName] || variableName} (${limitDef.maxValue})`,
          variableName,
          currentCount,
          maxValue: limitDef.maxValue,
        })
        return
      }

      // Agregar info de uso al response (para warnings)
      const percentage = Math.round((currentCount / limitDef.maxValue) * 100)
      if (percentage >= 80) {
        // Inyectar warning que las rutas pueden incluir en la respuesta
        ;(req as any)._usageWarning = {
          variableName,
          displayName: limitDef.displayName || KIRI_VARIABLE_DISPLAY[variableName],
          currentCount,
          maxValue: limitDef.maxValue,
          percentage,
          message: `Estás cerca del límite de ${limitDef.displayName || KIRI_VARIABLE_DISPLAY[variableName]} (${percentage}%)`,
        }
      }

      next()
    } catch (error) {
      if (error instanceof AuthorizaError) {
        // Si Authoriza no está disponible, permitir la operación (fail-open)
        // pero loggear el error
        console.error('[LimitEnforcement] Authoriza unavailable, allowing operation:', error.message)
        next()
        return
      }
      next(error)
    }
  }
}

// ─── Helper para adjuntar warning al response ────────────────────────────────

/**
 * Helper que las rutas pueden usar para incluir el usage warning en la respuesta.
 */
export function attachUsageWarning(req: Request, data: any): any {
  const warning = (req as any)._usageWarning
  if (warning && data && typeof data === 'object') {
    return { ...data, _usageWarning: warning }
  }
  return data
}
