import { Router, Request, Response } from 'express'
import { timingSafeEqual } from 'crypto'
import { prisma } from '../config/database.js'
import { acreditarPaquete, paqueteDeProducto, revertirPaquete } from '../lib/economia.js'
import { olvidarPlan } from '../lib/planes.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Compras dentro de la app (App Store / Google Play) — webhook de RevenueCat
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * La app nativa compra con la tienda (lib/nativo.ts del frontend) y RevenueCat
 * avisa aquí. SOLO este webhook abona monedas o activa planes: el celular nunca.
 *   REVENUECAT_WEBHOOK_SECRET: el valor que se pone en RevenueCat como cabecera
 *   "Authorization" (se compara con "Bearer <secreto>"). Sin la variable, cerrado.
 *
 * El app_user_id de RevenueCat es el id del usuario en Kiri (lo fija el SDK al
 * configurar). Productos: kiri_monedas_250/600/1300/2800 (consumibles) y
 * kiri_plus_mensual / kiri_pro_mensual (suscripciones).
 */
const router = Router()

const TIER_DE_PRODUCTO: Record<string, 'PLUS' | 'PRO'> = { kiri_plus_mensual: 'PLUS', kiri_pro_mensual: 'PRO' }

function autorizado(req: Request) {
  const secreto = process.env.REVENUECAT_WEBHOOK_SECRET || ''
  if (secreto.length < 16) return false
  const a = Buffer.from(String(req.headers.authorization || '')), b = Buffer.from(`Bearer ${secreto}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

interface EventoRC {
  type?: string; app_user_id?: string; aliases?: string[]; product_id?: string; new_product_id?: string
  transaction_id?: string; expiration_at_ms?: number | null; cancel_reason?: string; environment?: string; store?: string
}

router.post('/revenuecat', async (req: Request, res: Response): Promise<void> => {
  if (!autorizado(req)) { res.status(401).json({ error: 'No autorizado' }); return }
  const ev = (req.body?.event ?? null) as EventoRC | null
  if (!ev?.type) { res.status(400).json({ error: 'Evento inválido' }); return }
  if (ev.type === 'TEST') { res.json({ ok: true }); return }
  try {
    // El usuario puede venir como app_user_id o en los alias (si cambió de identidad en el SDK)
    const ids = [ev.app_user_id, ...(ev.aliases ?? [])].filter((x): x is string => !!x)
    const user = await prisma.user.findFirst({ where: { id: { in: ids } }, select: { id: true, planTienda: true } })
    if (!user) { console.warn(`[Pagos] evento ${ev.type} de un usuario que no existe (${ev.app_user_id})`); res.json({ ok: true, ignorado: 'usuario' }); return }
    const userId = user.id

    /* monedas: consumibles */
    const paquete = ev.product_id ? paqueteDeProducto(ev.product_id) : null
    if (paquete) {
      if ((ev.type === 'NON_RENEWING_PURCHASE' || ev.type === 'INITIAL_PURCHASE') && ev.transaction_id) {
        const r = await acreditarPaquete(userId, ev.product_id!, ev.transaction_id)
        console.info(`[Pagos] ${ev.store ?? ''} ${ev.environment ?? ''} ${ev.product_id} → +${r.monedas} monedas a ${userId}`)
      } else if (ev.type === 'CANCELLATION' && ev.cancel_reason === 'CUSTOMER_SUPPORT' && ev.transaction_id) {
        await revertirPaquete(userId, ev.transaction_id)
        console.info(`[Pagos] reembolso de ${ev.product_id} a ${userId}`)
      }
      res.json({ ok: true }); return
    }

    /* planes: suscripciones (en un cambio de plan el nuevo viene en new_product_id) */
    const producto = ev.type === 'PRODUCT_CHANGE' ? ev.new_product_id ?? ev.product_id : ev.product_id
    const tier = producto ? TIER_DE_PRODUCTO[producto] : undefined
    if (tier) {
      const hasta = ev.expiration_at_ms ? new Date(ev.expiration_at_ms) : new Date(Date.now() + 31 * 86400000)
      if (['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED'].includes(ev.type)) {
        await prisma.user.update({ where: { id: userId }, data: { planTienda: tier, planTiendaHasta: hasta } })
      } else if (ev.type === 'EXPIRATION' || (ev.type === 'CANCELLATION' && ev.cancel_reason === 'CUSTOMER_SUPPORT')) {
        // Cancelar sin reembolso deja el plan hasta que venza (llega luego como EXPIRATION)
        if (!user.planTienda || user.planTienda === tier) await prisma.user.update({ where: { id: userId }, data: { planTiendaHasta: new Date() } })
      }
      olvidarPlan(userId)
      console.info(`[Pagos] ${ev.type} ${producto} (${tier}) para ${userId}`)
    }
    res.json({ ok: true })
  } catch (error) {
    // RevenueCat reintenta si no recibe 2xx: los abonos son idempotentes por transacción
    console.error('[Pagos] webhook:', error)
    res.status(500).json({ error: 'No se pudo procesar el evento' })
  }
})

export default router
