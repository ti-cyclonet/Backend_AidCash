/**
 * Compras dentro de la app: webhook de RevenueCat (routes/pagos.routes.ts).
 * Monta el router con una clave de prueba y un usuario temporal (se borra al final).
 *   npx tsx scripts/e2e-pagos-tienda.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4197
process.env.REVENUECAT_WEBHOOK_SECRET = 'clave-de-prueba-revenuecat-123'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const express = (await import('express')).default
  const pagos = (await import('../src/routes/pagos.routes.js')).default
  const { resolverPlan, olvidarPlan } = await import('../src/lib/planes.js')
  const eco = await import('../src/lib/economia.js')
  const app = express(); app.use(express.json()); app.use('/api/pagos', pagos)
  const server = app.listen(APP_PORT)
  const stamp = Date.now()
  const u = await prisma.user.create({ data: { nombre: 'Tienda Prueba', correo: `tienda-${stamp}@local.test`, username: `tienda${stamp}`, passwordHash: 'x', onboardingDone: true } })
  const evento = async (event: Record<string, unknown>, clave = process.env.REVENUECAT_WEBHOOK_SECRET) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/pagos/revenuecat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clave}` }, body: JSON.stringify({ api_version: '1.0', event }) })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, unknown>
  }
  const monedas = async () => (await prisma.user.findUnique({ where: { id: u.id }, select: { monedas: true } }))!.monedas
  try {
    check('Clave equivocada → 401', (await evento({ type: 'TEST' }, 'otra-clave-cualquiera-xx')).status === 401)
    check('Evento de prueba de RevenueCat → 200', (await evento({ type: 'TEST' })).status === 200)
    const t0 = await eco.estadoTienda(u.id)
    check('La tienda avisa que la primera compra trae el doble', t0.primeraCompraDoble === true && t0.paquetes[0].producto === 'kiri_monedas_250')

    await evento({ type: 'NON_RENEWING_PURCHASE', app_user_id: u.id, product_id: 'kiri_monedas_250', transaction_id: 'tx-1', store: 'PLAY_STORE', environment: 'SANDBOX' })
    check('Primera compra de 250 → 500 monedas (doble)', await monedas() === 500, await monedas())
    await evento({ type: 'NON_RENEWING_PURCHASE', app_user_id: u.id, product_id: 'kiri_monedas_250', transaction_id: 'tx-1' })
    check('La tienda avisa dos veces la misma compra → no se abona dos veces', await monedas() === 500)
    await evento({ type: 'NON_RENEWING_PURCHASE', app_user_id: u.id, product_id: 'kiri_monedas_600', transaction_id: 'tx-2' })
    check('Segunda compra (600) ya no es doble', await monedas() === 1100, await monedas())
    await evento({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: u.id, product_id: 'kiri_monedas_600', transaction_id: 'tx-2' })
    check('Reembolso → se descuentan esas monedas', await monedas() === 500, await monedas())
    check('Usuario que no existe → se ignora sin error', (await evento({ type: 'NON_RENEWING_PURCHASE', app_user_id: 'no-existe', product_id: 'kiri_monedas_250', transaction_id: 'tx-x' })).ignorado === 'usuario')

    // ── Suscripción ──
    const vence = Date.now() + 30 * 86400000
    await evento({ type: 'INITIAL_PURCHASE', app_user_id: u.id, product_id: 'kiri_pro_mensual', transaction_id: 'sub-1', expiration_at_ms: vence })
    olvidarPlan(u.id)
    let plan = await resolverPlan(u.id)
    check('Suscripción PRO comprada en la app → plan PRO (fuente tienda)', plan.tier === 'PRO' && plan.fuente === 'tienda', { tier: plan.tier, fuente: plan.fuente })
    await evento({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', app_user_id: u.id, product_id: 'kiri_pro_mensual', expiration_at_ms: vence })
    olvidarPlan(u.id); plan = await resolverPlan(u.id)
    check('Cancelar sin reembolso deja el plan hasta que venza', plan.tier === 'PRO')
    await evento({ type: 'EXPIRATION', app_user_id: u.id, product_id: 'kiri_pro_mensual' })
    olvidarPlan(u.id); plan = await resolverPlan(u.id)
    check('Al vencer vuelve a su plan normal', plan.tier !== 'PRO' || plan.fuente !== 'tienda', { tier: plan.tier, fuente: plan.fuente })
  } catch (e) {
    console.error('ERROR', e)
    results.push(false)
  } finally {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {})
    await prisma.$disconnect()
    server.close()
    console.log(`\n${results.filter(Boolean).length}/${results.length} OK — usuario temporal eliminado`)
    process.exit(0)
  }
}
main()
