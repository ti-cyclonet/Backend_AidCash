/**
 * Prueba de los planes KIRI FREE / PLUS / PRO sin Authoriza real: monta las
 * rutas en un puerto aparte (sin crons) con un Authoriza simulado que dice qué
 * contrato tiene cada correo. Crea usuarios temporales y los borra al final.
 *   npx tsx scripts/e2e-planes.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4198
const APP_PORT = 4197
const CLAVE = 'clave-interna-de-prueba-1234567890'
process.env.AUTHORIZA_API_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.INTERNAL_API_KEY = CLAVE

// correo → paquete en Authoriza ('caido' = Authoriza responde 500)
const contratos = new Map<string, string>()
// Lo que Kiri le pidió a Authoriza al cambiar de plan (body + si mandó la clave interna)
const upgrades: { body: Record<string, any>; conClave: boolean }[] = []
const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url?.startsWith('/api/packages/landing')) {
      return json(200, [{ packageId: 'pkg-free', name: 'KIRI FREE', price: 0 }, { packageId: 'pkg-plus', name: 'KIRI PLUS', price: 14900 }, { packageId: 'pkg-pro', name: 'KIRI PRO', price: 24900 }])
    }
    if (req.url === '/api/auth/upgrade-plan') {
      upgrades.push({ body: JSON.parse(data || '{}'), conClave: req.headers['x-internal-key'] === CLAVE })
      return json(200, { message: 'Contrato creado' })
    }
    if (req.url === '/api/auth/check-email') {
      const { email } = JSON.parse(data || '{}')
      if (contratos.get(email) === 'caido') return json(500, {})
      return json(200, { exists: true, userId: encodeURIComponent(email) })
    }
    const m = req.url?.match(/^\/api\/contracts\/tenant\/([^/]+)\/limits/)
    if (m) {
      const pkg = contratos.get(decodeURIComponent(m[1]))
      if (!pkg) return json(404, { message: 'Sin contrato activo' })
      return json(200, { packageName: pkg, contractId: `c-${pkg}`, isBillable: true, limits: [] })
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
  const { periodoIA } = await import('../src/middleware/limit-enforcement.js')
  const { resolverPlan, invalidarPlan } = await import('../src/lib/planes.js')
  const { acreditarReferido } = await import('../src/lib/invitaciones.js')
  const rutas: [string, string][] = [
    ['/api/plan', 'plan'], ['/api/budget-categories', 'budget-categories'], ['/api/savings-pockets', 'savings-pockets'],
    ['/api/external-loans', 'external-loans'], ['/api/loans', 'loans'], ['/api/shared-pockets', 'shared-pockets'],
    ['/api/hogar', 'hogar'], ['/api/ai', 'ai'], ['/api/reports', 'reports'], ['/api/projections', 'projections'],
    ['/api/usage-status', 'usage-status'], ['/api/gamification', 'gamification'],
  ]
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  for (const [base, archivo] of rutas) app.use(base, (await import(`../src/routes/${archivo}.routes.js`)).default)
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const crear = async (nombre: string, extra: Record<string, unknown> = {}) => {
    const correo = `${nombre.toLowerCase()}-${stamp}@planes.test`
    const u = await prisma.user.create({ data: { nombre: `${nombre} Prueba`, correo, username: `${nombre.toLowerCase()}${stamp}`, passwordHash: 'x', onboardingDone: true, ...extra } })
    ids.push(u.id)
    return { ...u, token: jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  }
  const call = async (u: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }

  try {
    const F = await crear('Felipe')                                                     // FREE
    const T = await crear('Tania', { pruebaPlusHasta: new Date(Date.now() + 10 * 86400000) }) // días de PLUS ganados por invitar
    const P = await crear('Paula')                                                      // PRO por contrato
    const M = await crear('Mario')                                                      // FREE, pareja de Paula
    const X = await crear('Ximena')                                                     // Authoriza caído
    const I = await crear('Iris')                                                       // FREE que invita
    contratos.set(P.correo, 'KIRI PRO')
    contratos.set(X.correo, 'caido')
    await prisma.connection.create({ data: { requesterId: P.id, addresseeId: M.id, status: 'ACCEPTED', role: 'PARTNER' } })

    // ── Plan efectivo de cada uno ──
    const pf = await call(F, 'GET', '/plan')
    check('Felipe sin contrato → KIRI FREE (gratis)', pf.tier === 'FREE' && pf.fuente === 'gratis' && pf.limits.nCategorias.maxValue === 5, { tier: pf.tier, fuente: pf.fuente })
    const pt = await call(T, 'GET', '/plan')
    check('Tania con días de PLUS ganados por invitar → KIRI PLUS con fecha de fin', pt.tier === 'PLUS' && pt.fuente === 'prueba' && !!pt.pruebaHasta)
    const pp = await call(P, 'GET', '/plan')
    check('Paula con contrato KIRI PRO → PRO', pp.tier === 'PRO' && pp.fuente === 'contrato' && pp.features.householdBudget === true)
    const pm = await call(M, 'GET', '/plan')
    check('Mario, pareja de Paula (PRO) → sigue en KIRI FREE (ya no hay PLUS gratis por la pareja)', pm.tier === 'FREE' && pm.fuente === 'gratis', { tier: pm.tier, fuente: pm.fuente })
    const px = await call(X, 'GET', '/plan')
    check('Authoriza caído → "sin conexión" (no se bloquea a nadie)', px.fuente === 'sin_conexion')
    await new Promise(r => setTimeout(r, 300))
    check('Paula recibe la insignia PRO "Jardín dorado" al consultar su plan', !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: P.id, badgeId: 'pro_jardin_dorado' } } })))

    // ── Límites de cantidad (403 LIMITE con "mejora") ──
    let ultima: Record<string, any> = {}
    for (let i = 1; i <= 6; i++) ultima = await call(F, 'POST', '/budget-categories', { nombre: `Cat ${i}` })
    check('FREE: la 6.ª categoría → 403 LIMITE', ultima.status === 403 && ultima.codigo === 'LIMITE' && ultima.maxValue === 5, ultima.message)
    check('…con el mensaje y la mejora a PLUS (20)', ultima.mejora?.plan === 'KIRI PLUS' && ultima.mejora?.maxValue === 20 && /5 categorías/.test(ultima.message))
    check('…y solo quedaron 5', (await prisma.budgetCategory.count({ where: { userId: F.id } })) === 5)
    for (let i = 1; i <= 4; i++) ultima = await call(F, 'POST', '/savings-pockets', { nombre: `Bolsillo ${i}` })
    check('FREE: el 4.º bolsillo → 403', ultima.status === 403 && ultima.variableName === 'nBolsillos')
    for (let i = 1; i <= 4; i++) ultima = await call(F, 'POST', '/external-loans', { persona: `Amigo ${i}`, monto: 1000, salioDeBilletera: false })
    check('FREE: el 4.º "Me deben" → 403', ultima.status === 403 && ultima.variableName === 'nMeDeben')
    for (let i = 1; i <= 6; i++) ultima = await call(T, 'POST', '/budget-categories', { nombre: `Cat ${i}` })
    check('En prueba de PLUS sí puede crear más de 5 categorías', ultima.status === 201, ultima.status)
    for (let i = 1; i <= 6; i++) ultima = await call(X, 'POST', '/budget-categories', { nombre: `Cat ${i}` })
    check('Sin conexión con Authoriza no se bloquea (6 categorías)', ultima.status === 201)

    // ── Funciones de otro plan (403 FUNCION) ──
    const pr = await call(F, 'POST', '/loans/existente', { otroId: M.id, rol: 'yo_preste', monto: 5000, pendiente: 5000 })
    check('FREE: préstamos entre usuarios → 403 FUNCION (desde PLUS)', pr.status === 403 && pr.codigo === 'FUNCION' && pr.mejora?.plan === 'KIRI PLUS', pr.message)
    const sp = await call(F, 'POST', '/shared-pockets', { partnerIds: [M.id], nombre: 'Viaje' })
    check('FREE: bolsillos compartidos → 403 FUNCION', sp.status === 403 && sp.feature === 'sharedPockets')
    const esF = await call(F, 'POST', '/projections/escenarios', { nombre: 'Agresivo', aporteExtra: 200000, recortarHormiga: true, meses: 12 })
    check('FREE: guardar escenarios → 403 (es de PRO)', esF.status === 403 && esF.mejora?.plan === 'KIRI PRO')
    const bF = await call(F, 'POST', '/gamification/badges', { badgeId: 'pro_estratega' })
    check('FREE no puede darse una insignia PRO', bF.status === 403)

    // ── Presupuesto del hogar (PRO; basta uno de la pareja) ──
    const hF = await call(F, 'GET', '/hogar')
    check('Hogar de Felipe (sin pareja) → no habilitado', hF.habilitado === false)
    const hM = await call(M, 'GET', '/hogar')
    check('Hogar de Mario → habilitado gracias al PRO de Paula', hM.conectado === true && hM.habilitado === true)
    const cM = await call(M, 'POST', '/hogar/categorias', { nombre: 'Mercado', montoLimite: 500000 })
    check('Mario crea una categoría del hogar', cM.status === 201, cM.status)
    const cP = await call(P, 'POST', '/hogar/categorias', { nombre: 'Salidas', montoLimite: 200000 })
    await new Promise(r => setTimeout(r, 300))
    check('Paula (PRO) crea otra y gana la insignia "Hogar en equipo"', cP.status === 201 && !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: P.id, badgeId: 'pro_hogar_equipo' } } })))

    // ── Escenarios guardados (PRO) ──
    const esP = await call(P, 'POST', '/projections/escenarios', { nombre: 'Con prima', aporteExtra: 300000, recortarHormiga: false, meses: 24 })
    check('PRO guarda un escenario', esP.status === 201 && esP.escenario?.aporteExtra === 300000)
    const lista = await call(P, 'GET', '/projections/escenarios')
    check('…lo ve en su lista', lista.escenarios?.length === 1 && lista.escenarios[0].nombre === 'Con prima')
    await new Promise(r => setTimeout(r, 300))
    check('…y gana la insignia "Estratega"', !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: P.id, badgeId: 'pro_estratega' } } })))
    const del = await call(P, 'DELETE', `/projections/escenarios/${esP.escenario.id}`)
    const delOtro = await call(F, 'DELETE', `/projections/escenarios/${esP.escenario.id}`)
    check('Se borra; nadie más puede borrar escenarios ajenos', del.status === 200 && delOtro.status === 404)

    // ── Cuotas mensuales de IA ──
    const usoF = await call(F, 'GET', '/ai/uso')
    check('FREE: 10 mensajes, 10 dictados y 3 escaneos al mes', usoF.coach?.limite === 10 && usoF.dictado?.limite === 10 && usoF.escaneo?.limite === 3 && usoF.coach.restantes === 10)
    await prisma.aiUso.create({ data: { userId: F.id, periodo: periodoIA(), tipo: 'coach', cantidad: 10 } })
    const c429 = await call(F, 'POST', '/ai/coach', { mensaje: '¿cómo voy?' })
    check('Mensaje 11 del mes → 429 CUOTA_IA con la mejora a PLUS (150)', c429.status === 429 && c429.codigo === 'CUOTA_IA' && c429.mejora?.maxValue === 150, c429.error)
    const usoP = await call(P, 'GET', '/ai/uso')
    check('PRO: 500 mensajes, 300 dictados, 100 escaneos', usoP.coach?.limite === 500 && usoP.dictado?.limite === 300 && usoP.escaneo?.limite === 100)

    // ── Historial según el plan ──
    const hace = new Date(); hace.setFullYear(hace.getFullYear() - 1)
    const desde = hace.toISOString().slice(0, 10)
    const hasta = new Date().toISOString().slice(0, 10)
    const balF = await call(F, 'GET', `/reports/balance?timeframe=custom&from=${desde}&to=${hasta}`)
    check('FREE: pedir un año de historial → se recorta a 3 meses y se avisa', balF.historialLimitado?.meses === 3 && balF.historialLimitado?.mejora?.plan === 'KIRI PLUS' && new Date(balF.from) > hace, balF.historialLimitado)
    const balP = await call(P, 'GET', `/reports/balance?timeframe=custom&from=${desde}&to=${hasta}`)
    check('PRO: historial completo, sin recorte', balP.status === 200 && !balP.historialLimitado)

    // ── Mi plan: uso ──
    const uso = await call(F, 'GET', '/usage-status')
    const cats = uso.variables?.find((v: any) => v.variableName === 'nCategorias')
    const ia = uso.variables?.find((v: any) => v.variableName === 'iaMensajesMes')
    check('Tu uso este mes: 5/5 categorías y 10/10 mensajes', cats?.currentCount === 5 && cats?.maxValue === 5 && cats?.usagePercentage === 100 && ia?.currentCount === 10, { cats, ia })

    // ── Invitar amigos: el amigo tiene descuento; quien invita gana 10 días cuando el amigo paga ──
    const diasDe = async (u: { id: string }) => { const x = await prisma.user.findUnique({ where: { id: u.id }, select: { pruebaPlusHasta: true } }); return x?.pruebaPlusHasta ? (x.pruebaPlusHasta.getTime() - Date.now()) / 86400000 : 0 }
    const pagada = (u: { correo: string }, codigo: string) => fetch(`http://127.0.0.1:${APP_PORT}/api/plan/factura-evento`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': CLAVE },
      body: JSON.stringify({ email: u.correo, evento: 'pagada', factura: { codigo, valor: 7450 } }),
    }).then(r => r.json() as Promise<Record<string, any>>)
    const mision = async (u: { id: string }, key: string) => (await prisma.missionProgress.findUnique({ where: { userId_missionKey_periodo: { userId: u.id, missionKey: key, periodo: 'referidos' } } }))?.progress ?? 0

    const N = await crear('Nico', { invitedById: I.id, isActive: true })
    await prisma.connection.create({ data: { requesterId: I.id, addresseeId: N.id, status: 'ACCEPTED', role: 'FRIEND' } })
    await acreditarReferido(N.id)
    check('Registrarse con el enlace ya NO da días gratis a quien invita', (await diasDe(I)) === 0)
    const planN = await call(N, 'GET', '/plan')
    check('Nico llegó invitado → tiene 50% en PLUS y 30% en PRO para su primer mes', planN.descuentoInvitado?.PLUS === 50 && planN.descuentoInvitado?.PRO === 30, planN.descuentoInvitado)
    check('Felipe (sin invitación) no tiene descuento', (await call(F, 'GET', '/plan')).descuentoInvitado === null)

    upgrades.length = 0
    await call(N, 'POST', '/plan/upgrade', { packageId: 'pkg-plus', password: 'x', packageName: 'KIRI PLUS', billingCycle: 'monthly' })
    check('Nico se pasa a PLUS mensual → Kiri pide a Authoriza 50% en la primera factura, con la clave interna', upgrades[0]?.body.firstInvoiceDiscountPct === 50 && upgrades[0]?.conClave, upgrades[0])
    await call(N, 'POST', '/plan/upgrade', { packageId: 'pkg-pro', password: 'x', packageName: 'KIRI PLUS', billingCycle: 'monthly' })
    check('PRO (aunque el navegador diga "PLUS") → 30%: el plan sale del catálogo de Authoriza', upgrades[1]?.body.firstInvoiceDiscountPct === 30, upgrades[1]?.body)
    await call(N, 'POST', '/plan/upgrade', { packageId: 'pkg-plus', password: 'x', packageName: 'KIRI PLUS', billingCycle: 'annual' })
    check('Pago anual → sin descuento de invitado', upgrades[2] && upgrades[2].body.firstInvoiceDiscountPct === undefined, upgrades[2]?.body)
    check('…y no queda ningún % guardado para su primera factura', (await prisma.user.findUnique({ where: { id: N.id } }))?.descuentoPrimerMes === null)
    await call(F, 'POST', '/plan/upgrade', { packageId: 'pkg-plus', password: 'x', packageName: 'KIRI PLUS', billingCycle: 'monthly' })
    check('Felipe (no invitado) → sin descuento', upgrades[3] && upgrades[3].body.firstInvoiceDiscountPct === undefined)
    await call(N, 'POST', '/plan/upgrade', { packageId: 'pkg-plus', password: 'x', packageName: 'KIRI PLUS', billingCycle: 'monthly' })
    check('Nico vuelve a elegir PLUS mensual → queda el 50% para su primera factura', (await prisma.user.findUnique({ where: { id: N.id } }))?.descuentoPrimerMes === 50)
    check('Antes de pagar, Mi plan aún no muestra "tu primer mes tuvo descuento"', (await call(N, 'GET', '/plan')).primerMesInvitado === null)

    const r1 = await pagada(N, 'F-1')
    const d1 = await diasDe(I)
    check('Nico paga su primera factura → Iris gana 10 días de KIRI PLUS', r1.referidoPremiado === true && d1 > 9.9 && d1 <= 10.01, d1.toFixed(2))
    check('…avanza su misión "Un amigo se suscribe"', (await mision(I, 'referido_1')) === 1)
    const planNPago = await call(N, 'GET', '/plan')
    check('…y Nico ya no tiene descuento de invitado', planNPago.descuentoInvitado === null)
    check('…durante ese mes, Mi plan le recuerda que su primer mes tuvo 50%', planNPago.primerMesInvitado?.pct === 50, planNPago.primerMesInvitado)
    await prisma.user.update({ where: { id: N.id }, data: { primerPagoEn: new Date(Date.now() - 31 * 86_400_000) } })
    check('Pasado el mes, el aviso desaparece (ya paga precio normal)', (await call(N, 'GET', '/plan')).primerMesInvitado === null)
    invalidarPlan(I.id)
    const planI = await resolverPlan(I.id)
    check('Iris ahora tiene KIRI PLUS por invitar', planI.tier === 'PLUS' && planI.fuente === 'prueba')
    await pagada(N, 'F-2')
    check('Una segunda factura de Nico no vuelve a premiar', Math.abs((await diasDe(I)) - d1) < 0.01)

    for (const nombre of ['Olga', 'Pablo', 'Quique']) {
      const amigo = await crear(nombre, { invitedById: I.id, isActive: true })
      await pagada(amigo, `F-${nombre}`)
    }
    const d4 = await diasDe(I)
    check('Solo los 3 primeros amigos suscritos dan días: 4 amigos → 30 días, no 40', d4 > 29.9 && d4 <= 30.02, d4.toFixed(2))
    check('…y las 3 misiones de invitar quedan completas', (await mision(I, 'referido_3')) === 3)
    const planIris = await call(I, 'GET', '/plan')
    check('Mi plan de Iris muestra 4 amigos suscritos (tope de premio 3, 10 días c/u)', planIris.referidos?.suscritos === 4 && planIris.referidos?.maximo === 3 && planIris.referidos?.diasPorReferido === 10, planIris.referidos)

    await prisma.user.update({ where: { id: I.id }, data: { pruebaPlusHasta: new Date(Date.now() - 1000) } })
    invalidarPlan(I.id)
    check('Al vencerse los días vuelve a FREE', (await resolverPlan(I.id)).tier === 'FREE')

    const nuevo = await prisma.user.findUnique({ where: { id: F.id }, select: { pruebaPlusHasta: true } })
    check('Registrarse ya no da prueba de PLUS (sin días por defecto)', nuevo?.pruebaPlusHasta === null)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    const quedan = await prisma.user.count({ where: { id: { in: ids } } })
    console.log(`\nUsuarios temporales borrados (${ids.length}); quedan: ${quedan}`)
    server.close(); mock.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} pasaron`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
