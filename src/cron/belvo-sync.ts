/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Cron: Sincronización automática con Belvo
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Se ejecuta todos los días a las 6:00 AM.
 * Recorre todos los BelvoLinks con accessMode "recurrent" y status "valid",
 * y sincroniza las transacciones de los últimos 3 días para cada uno.
 *
 * Esto garantiza que los ingresos y egresos bancarios del usuario estén
 * actualizados sin intervención manual.
 */

import cron from 'node-cron'
import { prisma } from '../config/database.js'
import { belvoService } from '../services/belvo.service.js'

/**
 * Sincroniza transacciones de un link específico para los últimos N días.
 */
async function syncLinkTransactions(linkId: string, belvoLinkId: string, days = 3): Promise<number> {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
  const dateFrom = from.toISOString().split('T')[0]
  const dateTo = now.toISOString().split('T')[0]

  // Sincronizar cuentas (actualizar balances)
  const accountsResult = await belvoService.retrieveAccounts(linkId)
  if (accountsResult.data) {
    for (const acc of accountsResult.data) {
      await prisma.belvoAccount.upsert({
        where: { accountId: acc.id },
        create: {
          belvoLinkId,
          accountId: acc.id,
          nombre: acc.name || 'Cuenta',
          tipo: mapCategory(acc.category),
          numero: acc.number ? acc.number.slice(-4) : null,
          moneda: acc.currency || 'COP',
          balanceActual: acc.balance.current,
          balanceDisponible: acc.balance.available,
        },
        update: {
          balanceActual: acc.balance.current,
          balanceDisponible: acc.balance.available,
        },
      })
    }
  }

  // Sincronizar transacciones
  const txResult = await belvoService.retrieveTransactions(linkId, dateFrom, dateTo)
  let synced = 0

  if (txResult.data) {
    for (const tx of txResult.data) {
      await prisma.belvoTransaction.upsert({
        where: { transactionId: tx.id },
        create: {
          belvoLinkId,
          transactionId: tx.id,
          accountId: tx.account.id,
          fecha: new Date(tx.value_date),
          monto: tx.amount,
          tipo: tx.type,
          categoria: tx.category,
          descripcion: tx.description,
          comercio: tx.merchant?.name || null,
          status: tx.status || 'PROCESSED',
        },
        update: {
          monto: tx.amount,
          categoria: tx.category,
          status: tx.status || 'PROCESSED',
        },
      })
      synced++
    }
  }

  return synced
}

function mapCategory(category: string): string {
  const map: Record<string, string> = {
    'CHECKING_ACCOUNT': 'checking',
    'SAVINGS_ACCOUNT': 'savings',
    'CREDIT_CARD': 'credit_card',
    'LOAN_ACCOUNT': 'loan',
    'PENSION_FUND_ACCOUNT': 'pension',
    'UNCATEGORIZED': 'other',
  }
  return map[category] || 'other'
}

/**
 * Job principal: sincroniza todos los links recurrentes y válidos.
 */
async function runBelvoSync() {
  if (!belvoService.isConfigured()) {
    console.log('[BelvoSync] Credenciales no configuradas, saltando...')
    return
  }

  console.log('[BelvoSync] Iniciando sincronización automática...')

  const links = await prisma.belvoLink.findMany({
    where: {
      accessMode: 'recurrent',
      status: 'valid',
    },
  })

  if (links.length === 0) {
    console.log('[BelvoSync] No hay links activos para sincronizar')
    return
  }

  let totalSynced = 0
  let errors = 0

  for (const link of links) {
    try {
      const synced = await syncLinkTransactions(link.linkId, link.id)
      totalSynced += synced

      // Actualizar timestamp de última sincronización
      await prisma.belvoLink.update({
        where: { id: link.id },
        data: { lastSyncAt: new Date() },
      })
    } catch (error) {
      errors++
      console.error(`[BelvoSync] Error sincronizando link ${link.id} (${link.institution}):`, error)

      // Marcar como inválido si hay errores repetidos
      if ((error as any)?.status === 401 || (error as any)?.status === 400) {
        await prisma.belvoLink.update({
          where: { id: link.id },
          data: { status: 'invalid' },
        })
      }
    }
  }

  console.log(`[BelvoSync] Completado: ${totalSynced} transacciones sincronizadas, ${errors} errores, ${links.length} links procesados`)
}

/**
 * Inicializa el cron job de Belvo.
 * Se ejecuta a las 6:00 AM todos los días.
 */
export function initBelvoSyncCron() {
  // Cron: "0 6 * * *" = cada día a las 6:00 AM
  cron.schedule('0 6 * * *', () => {
    runBelvoSync().catch(err => {
      console.error('[BelvoSync] Error fatal en cron:', err)
    })
  })

  console.log('  📊 Cron Belvo Sync: activo (6:00 AM diario)')
}
