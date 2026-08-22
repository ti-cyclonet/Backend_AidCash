/**
 * Cliente HTTP para comunicarse con Backend_Authoriza.
 * Obtiene información de contratos, paquetes y límites de uso.
 */
import { env } from '../config/env.js'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TenantLimitsResponse {
  contractId: string
  packageName: string
  isBillable: boolean
  startDate: string | null
  endDate: string | null
  limits: TenantLimit[]
}

export interface TenantLimit {
  variableName: string
  displayName: string
  maxValue: number
  targetApplication: string
}

// ─── Cache en memoria ─────────────────────────────────────────────────────────

interface CacheEntry {
  data: TenantLimitsResponse
  expiry: number
}

const limitsCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutos

/**
 * Invalida la cache para un tenant específico.
 * Puede ser llamado desde un endpoint público para que Authoriza notifique cambios.
 */
export function invalidateTenantCache(tenantId: string): void {
  limitsCache.delete(tenantId)
}

/**
 * Obtiene los límites del paquete activo para un tenant desde Authoriza.
 * Filtra solo las variables cuyo targetApplication sea "Kiri".
 * Usa cache en memoria con TTL de 5 minutos.
 */
export async function fetchTenantLimits(tenantId: string): Promise<TenantLimitsResponse> {
  // Revisar cache
  const cached = limitsCache.get(tenantId)
  if (cached && cached.expiry > Date.now()) {
    return cached.data
  }

  const url = `${env.AUTHORIZA_API_URL}/api/contracts/tenant/${tenantId}/limits?application=Kiri`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    if (response.status === 404) {
      throw new AuthorizaError(
        'CONTRACT_INACTIVE',
        'No se encontró un contrato activo para este tenant',
        403,
      )
    }

    if (!response.ok) {
      throw new AuthorizaError(
        'AUTHORIZA_UNAVAILABLE',
        'No se pudieron obtener los límites del paquete. Intente más tarde.',
        503,
      )
    }

    const data = await response.json() as TenantLimitsResponse

    // Guardar en cache
    limitsCache.set(tenantId, { data, expiry: Date.now() + CACHE_TTL_MS })

    return data
  } catch (error) {
    if (error instanceof AuthorizaError) throw error

    console.error(`[AuthorizaClient] Error fetching limits for tenant ${tenantId}:`, (error as Error).message)
    throw new AuthorizaError(
      'AUTHORIZA_UNAVAILABLE',
      'No se pudieron obtener los límites del paquete. Intente más tarde.',
      503,
    )
  }
}

/**
 * Obtiene los límites filtrados por targetApplication = "Kiri".
 */
export async function fetchKiriLimits(tenantId: string): Promise<TenantLimit[]> {
  const response = await fetchTenantLimits(tenantId)
  return response.limits.filter(l => l.targetApplication === 'Kiri')
}

// ─── Error personalizado ──────────────────────────────────────────────────────

export class AuthorizaError extends Error {
  code: string
  statusCode: number

  constructor(code: string, message: string, statusCode: number) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.name = 'AuthorizaError'
  }
}
