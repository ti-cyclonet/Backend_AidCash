/**
 * Prueba del idioma (español / inglés) en el backend, sin servicios reales:
 * Authoriza y Gemini simulados, rutas montadas en un puerto aparte.
 * Crea usuarios temporales y los borra al final.
 *   npx tsx scripts/e2e-idioma.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4192
const APP_PORT = 4191
process.env.AUTHORIZA_API_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.GEMINI_API_BASE = `http://127.0.0.1:${MOCK_PORT}`
process.env.GEMINI_API_KEY = 'clave-de-prueba'

let ultimoPrompt = ''
const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    // Authoriza: nadie tiene contrato → KIRI FREE
    if (req.url === '/api/auth/check-email') return json(200, { exists: false })
    if (req.url?.startsWith('/api/auth/internal/')) return json(200, { url: null, name: null })
    // Gemini: guarda el prompt y responde algo fijo
    if (req.url?.includes(':generateContent')) {
      ultimoPrompt = data
      return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ respuesta: 'Hi!', acciones: [], sugerencias: [], ir: null }) }] } }] })
    }
    json(404, {})
  })
})

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { traducirRespuestas } = await import('../src/lib/i18n.js')
  const { emitToUser } = await import('../src/lib/socket.js')
  const app = express()
  app.use(express.json())
  app.use(traducirRespuestas)
  for (const [base, archivo] of [['/api/auth', 'auth'], ['/api/users', 'user'], ['/api/debts', 'debts'], ['/api/budget-categories', 'budget-categories'], ['/api/ai', 'ai']] as const) {
    app.use(base, (await import(`../src/routes/${archivo}.routes.js`)).default)
  }
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const crear = async (nombre: string) => {
    const correo = `${nombre.toLowerCase()}-${stamp}@idioma.test`
    const u = await prisma.user.create({ data: { nombre, correo, username: `${nombre.toLowerCase().slice(0, 6)}${stamp % 1000000}`, passwordHash: 'x', onboardingDone: true } })
    ids.push(u.id)
    return { ...u, token: jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  }
  const call = async (u: { token: string }, method: string, path: string, body?: unknown, idioma?: string) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}`, ...(idioma ? { 'x-kiri-idioma': idioma } : {}) }, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }

  try {
    const A = await crear('Ana')
    let me = (await call(A, 'GET', '/auth/me')).user
    check('Por defecto la cuenta está en español', me.idioma === 'es')
    const p = await call(A, 'PATCH', '/users/profile', { idioma: 'en' })
    check('Cambiar el idioma a inglés se guarda en la cuenta', p.status === 200 && p.user.idioma === 'en')
    me = (await call(A, 'GET', '/auth/me')).user
    check('/auth/me devuelve el idioma', me.idioma === 'en')
    const inval = await call(A, 'PATCH', '/users/profile', { idioma: 'fr' })
    check('Solo se aceptan es / en', inval.status === 400)

    // Errores de la API
    const es404 = await call(A, 'GET', '/debts/no-existe/pagos', undefined, 'es')
    const noEncontrada = await call(A, 'DELETE', '/debts/no-existe', undefined, 'en')
    const esDel = await call(A, 'DELETE', '/debts/no-existe', undefined, 'es')
    check('Error en español con la app en español', esDel.error === 'Deuda no encontrada', esDel.error)
    check('…y en inglés con la app en inglés', noEncontrada.error === 'Debt not found', noEncontrada.error)
    void es404

    // Mensajes con valores (límite del plan)
    let ultima: Record<string, any> = {}
    for (let i = 1; i <= 6; i++) ultima = await call(A, 'POST', '/budget-categories', { nombre: `Cat ${i}` }, 'en')
    check('Límite del plan en inglés, con sus valores', ultima.status === 403 && ultima.message === 'You reached your 5 budget categories on KIRI FREE. With KIRI PLUS you have 20.', ultima.message)
    check('…el código del error no se traduce', ultima.error === 'LIMIT_REACHED' && ultima.codigo === 'LIMITE')

    // Avisos y campana en el idioma de la cuenta
    emitToUser(A.id, 'kiri:aviso', { message: '🎉 ¡Deuda liquidada!', detalle: '¡Felicidades! Terminaste de pagar "Moto".', route: '/obligaciones' })
    await new Promise(r => setTimeout(r, 500))
    const n = await prisma.notification.findFirst({ where: { userId: A.id, event: 'kiri:aviso' }, orderBy: { createdAt: 'desc' } })
    const d = n?.data as Record<string, string> | undefined
    check('La notificación queda en inglés para quien usa la app en inglés', d?.message === '🎉 Debt paid off!' && d?.detalle === 'Congratulations! You finished paying "Moto".', d)
    check('…sin tocar la ruta', d?.route === '/obligaciones')
    const B = await crear('Beto')
    emitToUser(B.id, 'kiri:aviso', { message: '🎉 ¡Deuda liquidada!', route: '/obligaciones' })
    await new Promise(r => setTimeout(r, 500))
    const nb = await prisma.notification.findFirst({ where: { userId: B.id, event: 'kiri:aviso' } })
    check('Quien usa la app en español la recibe en español', (nb?.data as any)?.message === '🎉 ¡Deuda liquidada!')

    // Kiri Coach responde en el idioma de la app
    await prisma.user.update({ where: { id: A.id }, data: { ingresoBase: 2000000 } })
    const c = await call(A, 'POST', '/ai/coach', { mensaje: 'How am I doing?' }, 'en')
    check('Kiri Coach recibe la instrucción de responder en inglés', c.status === 200 && ultimoPrompt.includes('usa Kiri en INGLÉS'), c.status)
    ultimoPrompt = ''
    await call(B, 'POST', '/ai/coach', { mensaje: '¿Cómo voy?' }, 'es')
    check('…y en español no', !ultimoPrompt.includes('usa Kiri en INGLÉS') && ultimoPrompt.length > 0)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    console.log(`\nUsuarios temporales borrados (${ids.length}); quedan: ${await prisma.user.count({ where: { id: { in: ids } } })}`)
    server.close(); mock.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} pasaron`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
