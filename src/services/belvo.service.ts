/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Belvo Service — Integración Open Banking para Latinoamérica
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Este servicio encapsula toda la comunicación con la API de Belvo.
 * Flujo principal:
 *   1. Backend genera un widget access token → Frontend muestra el Connect Widget
 *   2. Usuario conecta su banco → Widget retorna link_id
 *   3. Backend registra el link y sincroniza cuentas/transacciones
 *   4. Cron job periódico actualiza transacciones automáticamente
 *
 * Documentación: https://developers.belvo.com/
 */

import { env } from '../config/env.js'

// ─── Configuración base ───────────────────────────────────────────────────────

const BELVO_BASE_URL = env.BELVO_ENV === 'production'
  ? 'https://api.belvo.com'
  : 'https://sandbox.belvo.com'

/**
 * Genera el header de autenticación Basic para Belvo.
 * Belvo usa HTTP Basic Auth con secret_id:secret_password codificado en Base64.
 */
function getAuthHeader(): string {
  const credentials = Buffer.from(`${env.BELVO_SECRET_ID}:${env.BELVO_SECRET_PASSWORD}`).toString('base64')
  return `Basic ${credentials}`
}

/**
 * Wrapper genérico para requests a la API de Belvo.
 * Maneja errores y retorna datos tipados.
 */
async function belvoRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(`${BELVO_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': getAuthHeader(),
        ...((options.headers as Record<string, string>) || {}),
      },
    })

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>
      const errorMsg = (errorBody?.detail as string) || (errorBody?.message as string) || `Belvo API error: ${res.status}`
      console.error(`[Belvo] ${endpoint} → ${res.status}:`, errorBody)
      return { data: null, error: errorMsg }
    }

    const data = await res.json() as T
    return { data, error: null }
  } catch (error) {
    console.error(`[Belvo] Request failed: ${endpoint}`, error)
    return { data: null, error: 'Error de conexión con Belvo' }
  }
}

// ─── Tipos de respuesta de Belvo ──────────────────────────────────────────────

export interface BelvoWidgetToken {
  access: string
  refresh: string
}

export interface BelvoAccountResponse {
  id: string
  link: string
  institution: { name: string; type: string }
  name: string
  category: string        // CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD | LOAN_ACCOUNT
  number: string | null
  currency: string
  balance: {
    current: number
    available: number | null
  }
  collected_at: string
}

export interface BelvoTransactionResponse {
  id: string
  account: { id: string; name: string }
  collected_at: string
  value_date: string
  amount: number
  type: 'INFLOW' | 'OUTFLOW'
  category: string | null
  description: string | null
  merchant: { name: string | null } | null
  status: string
}

// ─── Métodos públicos del servicio ────────────────────────────────────────────

export const belvoService = {
  /**
   * Genera un token de acceso para el Connect Widget de Belvo.
   * El frontend usa este token para inicializar el widget embebido.
   *
   * @param linkId - (Opcional) Si se quiere actualizar un link existente
   */
  async createWidgetToken(linkId?: string): Promise<{ data: BelvoWidgetToken | null; error: string | null }> {
    const body: Record<string, unknown> = {
      id: env.BELVO_SECRET_ID,
      password: env.BELVO_SECRET_PASSWORD,
      scopes: 'read_institutions,write_links,read_links,read_accounts,read_transactions',
    }

    // Si es para actualizar un link existente (mode: update)
    if (linkId) {
      body.link_id = linkId
    }

    return belvoRequest<BelvoWidgetToken>('/api/token/', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /**
   * Obtiene los detalles de un link (conexión bancaria) en Belvo.
   */
  async getLink(linkId: string) {
    return belvoRequest<{
      id: string
      institution: string
      access_mode: string
      status: string
      created_at: string
    }>(`/api/links/${linkId}/`)
  },

  /**
   * Elimina un link en Belvo (desconectar banco).
   */
  async deleteLink(linkId: string) {
    try {
      const res = await fetch(`${BELVO_BASE_URL}/api/links/${linkId}/`, {
        method: 'DELETE',
        headers: { 'Authorization': getAuthHeader() },
      })
      return { success: res.status === 204, error: null }
    } catch (error) {
      return { success: false, error: 'Error al desconectar banco en Belvo' }
    }
  },

  /**
   * Obtiene las cuentas asociadas a un link.
   * Belvo devuelve cuentas de ahorro, corriente, tarjetas, préstamos.
   */
  async retrieveAccounts(linkId: string): Promise<{ data: BelvoAccountResponse[] | null; error: string | null }> {
    return belvoRequest<BelvoAccountResponse[]>('/api/accounts/', {
      method: 'POST',
      body: JSON.stringify({ link: linkId }),
    })
  },

  /**
   * Obtiene las transacciones de un link en un rango de fechas.
   *
   * @param linkId - ID del link en Belvo
   * @param dateFrom - Fecha inicio (YYYY-MM-DD)
   * @param dateTo - Fecha fin (YYYY-MM-DD)
   */
  async retrieveTransactions(
    linkId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<{ data: BelvoTransactionResponse[] | null; error: string | null }> {
    return belvoRequest<BelvoTransactionResponse[]>('/api/transactions/', {
      method: 'POST',
      body: JSON.stringify({
        link: linkId,
        date_from: dateFrom,
        date_to: dateTo,
      }),
    })
  },

  /**
   * Lista transacciones ya obtenidas (GET) con paginación.
   * Útil para obtener transacciones que ya fueron extraídas previamente.
   */
  async listTransactions(linkId: string, page = 1, pageSize = 100) {
    return belvoRequest<{
      count: number
      next: string | null
      results: BelvoTransactionResponse[]
    }>(`/api/transactions/?link=${linkId}&page=${page}&page_size=${pageSize}`)
  },

  /**
   * Verifica si las credenciales de Belvo están configuradas.
   */
  isConfigured(): boolean {
    return !!(env.BELVO_SECRET_ID && env.BELVO_SECRET_PASSWORD)
  },
}
