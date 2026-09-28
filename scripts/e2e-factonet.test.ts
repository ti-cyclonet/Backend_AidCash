/**
 * Prueba de Mi plan + FactoNet sin Authoriza real: monta solo /api/plan en un
 * puerto aparte (sin crons), con INTERNAL_API_KEY de prueba y un Authoriza
 * simulado para el cambio de plan. Crea un usuario temporal y lo borra.
 *   npx tsx scripts/e2e-factonet.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4196
const APP_PORT = 4195
const CLAVE = 'clave-interna-de-prueba-1234567890'
process.env.INTERNAL_API_KEY = CLAVE
process.env.AUTHORIZA_API_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.FACTONET_URL = 'http://localhost:4202'

let ultimoUpgrade: Record<string, unknown> | null = null
const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    if (req.url === '/api/auth/upgrade-plan') {
      ultimoUpgrade = JSON.parse(data)
      const ok = ultimoUpgrade?.password === 'correcta'
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok ? { success: true, message: 'Contrato creado' } : { message: 'Contraseña incorrecta' }))
      return
    }
    res.writeHead(404); res.end('{}')
  })
})

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const planRoutes = (await import('../src/routes/plan.routes.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/plan', planRoutes)
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const correo = `plan-${stamp}@local.test`
  const u = await prisma.user.create({ data: { nombre: 'Pablo Plan', correo, username: `pabloplan${stamp}`, passwordHash: 'x', onboardingDone: true } })
  const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/plan${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const conToken = { Authorization: `Bearer ${token}` }
  const conClave = { 'x-internal-key': CLAVE }
  const factura = { codigo: 'DF1001', valor: 29900, emitida: '2026-10-01', vence: '2026-10-05', estado: 'Issued', plan: 'KIRI PLUS' }

  try {
    // ── Cambiar de plan desde Kiri ──
    const malo = await call('POST', '/upgrade', { packageId: 'pkg-plus', packageName: 'KIRI PLUS', password: 'mala', acceptTerms: true, acceptHabeasData: true }, conToken)
    check('Contraseña incorrecta → error de Authoriza, no se guarda nada', malo.status === 400 && malo.error.includes('Contraseña') && !(await prisma.user.findUnique({ where: { id: u.id } }))?.cambioPlan)
    const ok = await call('POST', '/upgrade', { packageId: 'pkg-plus', packageName: 'KIRI PLUS', password: 'correcta', acceptTerms: true, acceptHabeasData: true }, conToken)
    check('Cambio de plan desde Kiri → Authoriza crea el contrato', ok.status === 200 && ok.success === true)
    check('…Kiri le manda la aceptación de términos y datos', ultimoUpgrade?.acceptTerms === true && ultimoUpgrade?.acceptHabeasData === true && ultimoUpgrade?.email === correo)
    let fn = await call('GET', '/factonet', undefined, conToken)
    check('Mi plan muestra "contrato listo para firmar" y el acceso a FactoNet con su correo', fn.cambioPlan?.plan === 'KIRI PLUS' && fn.url === 'http://localhost:4202/login' && fn.correo === correo, fn)

    // ── Aviso de factura desde Authoriza/FactoNet ──
    const sinClave = await call('POST', '/factura-evento', { email: correo, evento: 'emitida', factura })
    check('Sin la clave interna no se aceptan avisos', sinClave.status === 401)
    const otro = await call('POST', '/factura-evento', { email: 'noexiste@x.co', evento: 'emitida', factura }, conClave)
    check('Correo que no es de Kiri → 404 (se ignora)', otro.status === 404)
    const emitida = await call('POST', '/factura-evento', { email: correo, evento: 'emitida', factura }, conClave)
    await new Promise(r => setTimeout(r, 400))
    check('Factura emitida → aceptada', emitida.status === 200)
    const aviso = await prisma.notification.findFirst({ where: { userId: u.id, event: 'kiri:aviso' }, orderBy: { createdAt: 'desc' } })
    const d = aviso?.data as Record<string, string> | undefined
    check('A Pablo le llega el aviso en Kiri con el valor', d?.message?.includes('$29.900') && d?.tipo === 'factura', d?.message)
    check('…y al tocarlo lo lleva al acceso a FactoNet en Mi plan', d?.route === '/mi-plan#factonet')
    fn = await call('GET', '/factonet', undefined, conToken)
    check('Mi plan muestra la factura pendiente', fn.facturaPendiente?.codigo === 'DF1001' && fn.facturaPendiente?.evento === 'emitida' && fn.facturaPendiente?.valor === 29900)
    await call('POST', '/factura-evento', { email: correo, evento: 'aviso_mora', factura: { ...factura, estado: 'Notification1' } }, conClave)
    fn = await call('GET', '/factonet', undefined, conToken)
    check('Recordatorio de mora actualiza el estado', fn.facturaPendiente?.evento === 'aviso_mora')
    const invalido = await call('POST', '/factura-evento', { email: correo, evento: 'otra-cosa', factura }, conClave)
    check('Evento desconocido → 400', invalido.status === 400)

    // ── Pago confirmado y plan activado ──
    await call('POST', '/factura-evento', { email: correo, evento: 'pagada', factura: { ...factura, estado: 'Paid' } }, conClave)
    fn = await call('GET', '/factonet', undefined, conToken)
    check('Pagada → desaparece la factura pendiente', fn.facturaPendiente === null)
    const act = await call('POST', '/activate-user', { email: correo, planUpgraded: true, packageName: 'KIRI PLUS' }, conClave)
    fn = await call('GET', '/factonet', undefined, conToken)
    check('Authoriza activa el plan → se quita "contrato por firmar"', act.status === 200 && fn.cambioPlan === null)
  } catch (e) {
    console.error('ERROR', e); results.push(false)
  } finally {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {})
    await prisma.$disconnect()
    server.close(); mock.close()
    console.log(`\n${results.filter(Boolean).length}/${results.length} OK — usuario temporal eliminado`)
    process.exit(0)
  }
}
main()
