/**
 * Programa "Invita y gana" (lib/referidos.ts) sin Authoriza real: rutas en un
 * puerto aparte (sin crons) y un Authoriza simulado con los contratos y los
 * meses gratis. Crea usuarios temporales y los borra al final.
 *   npx tsx scripts/e2e-referidos.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4188
const APP_PORT = 4187
const CLAVE = 'clave-interna-de-prueba-1234567890'
process.env.AUTHORIZA_API_URL = `http://127.0.0.1:${MOCK_PORT}`
process.env.INTERNAL_API_KEY = CLAVE

// correo → paquete pago en Authoriza
const contratos = new Map<string, string>()
// Meses gratis que Kiri pidió (correo, meses, si mandó la clave)
const mesesPedidos: { correo: string; meses: number; conClave: boolean }[] = []
// Correos para los que "free-months" falla (Authoriza caído en ese momento)
const freeMonthsCaido = new Set<string>()

const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.url === '/api/auth/check-email') {
      const { email } = JSON.parse(data || '{}')
      return json(200, { exists: true, userId: encodeURIComponent(email) })
    }
    const lim = req.url?.match(/^\/api\/contracts\/tenant\/([^/]+)\/limits/)
    if (lim) {
      const pkg = contratos.get(decodeURIComponent(lim[1]))
      if (!pkg) return json(404, { message: 'Sin contrato activo' })
      return json(200, { packageName: pkg, contractId: `c-${pkg}`, isBillable: true, limits: [] })
    }
    const fm = req.url?.match(/^\/api\/contracts\/tenant\/([^/]+)\/free-months/)
    if (fm && req.method === 'POST') {
      const correo = decodeURIComponent(fm[1])
      if (freeMonthsCaido.has(correo)) return json(500, {})
      const { months } = JSON.parse(data || '{}')
      mesesPedidos.push({ correo, meses: months, conClave: req.headers['x-internal-key'] === CLAVE })
      return json(200, contratos.get(correo) ? { applied: true, freeMonthsCredit: months } : { applied: false, reason: 'sin_contrato' })
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
  const { recordMissionAction } = await import('../src/lib/missions.js')
  const { periodoBono, revisarNiveles, reintentarPendientes } = await import('../src/lib/referidos.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  for (const [base, archivo] of [['/api/plan', 'plan'], ['/api/ai', 'ai'], ['/api/usage-status', 'usage-status'], ['/api/gamification', 'gamification']] as const) {
    app.use(base, (await import(`../src/routes/${archivo}.routes.js`)).default)
  }
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const crear = async (nombre: string, extra: Record<string, unknown> = {}) => {
    const correo = `${nombre.toLowerCase()}-${stamp}@referidos.test`
    const u = await prisma.user.create({ data: { nombre: `${nombre} Prueba`, correo, username: `${nombre.toLowerCase()}r${stamp}`, passwordHash: 'x', onboardingDone: true, ...extra } })
    ids.push(u.id)
    return { ...u, token: jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  }
  const call = async (u: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const pagada = (u: { correo: string }, codigo: string) => fetch(`http://127.0.0.1:${APP_PORT}/api/plan/factura-evento`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': CLAVE },
    body: JSON.stringify({ email: u.correo, evento: 'pagada', factura: { codigo, valor: 7450 } }),
  }).then(r => r.json() as Promise<Record<string, any>>)
  const dias = async (id: string, campo: 'pruebaPlusHasta' | 'pruebaProHasta' = 'pruebaPlusHasta') => {
    const x = await prisma.user.findUnique({ where: { id }, select: { pruebaPlusHasta: true, pruebaProHasta: true } })
    const f = x?.[campo]
    return f ? (f.getTime() - Date.now()) / 86_400_000 : 0
  }
  const bonos = async (id: string) => {
    const filas = await prisma.aiBono.groupBy({ by: ['tipo'], where: { userId: id, periodo: periodoBono() }, _sum: { cantidad: true } })
    return Object.fromEntries(filas.map(f => [f.tipo, f._sum.cantidad ?? 0])) as Record<string, number>
  }
  const gasto = (userId: string, haceDias = 0) => prisma.impulseExpense.create({
    data: { userId, nombre: 'Café', monto: 5000, periodo: periodoIA(), createdAt: new Date(Date.now() - haceDias * 86_400_000) } as any,
  })
  /** Amigo invitado por `inviter` que ya usa Kiri (3 movimientos en 2 días) */
  const amigoActivo = async (nombre: string, inviterId: string) => {
    const a = await crear(nombre, { invitedById: inviterId, isActive: true })
    await gasto(a.id, 1); await gasto(a.id); await gasto(a.id)
    await recordMissionAction(a.id, 'gasto_hormiga')
    return a
  }

  try {
    // ── Momento 1: llega con el enlace ──
    const Ana = await crear('Ana')
    const Beto = await crear('Beto', { invitedById: Ana.id, isActive: true })
    await acreditarReferido(Beto.id)
    const dB = await dias(Beto.id)
    check('Beto llega con el enlace de Ana → 14 días de KIRI PLUS', dB > 13.9 && dB <= 14.01, dB.toFixed(2))
    check('Ana todavía no gana nada (Beto aún no usa Kiri)', (await dias(Ana.id)) === 0 && Object.keys(await bonos(Ana.id)).length === 0)

    // ── Momento 2: Beto empieza a usar Kiri ──
    await gasto(Beto.id); await gasto(Beto.id)
    await recordMissionAction(Beto.id, 'gasto_hormiga')
    check('2 movimientos el mismo día → aún no cuenta como activo', (await prisma.user.findUnique({ where: { id: Beto.id } }))?.referidoActivadoEn === null)
    await gasto(Beto.id, 1)
    await recordMissionAction(Beto.id, 'gasto_hormiga')
    check('3 movimientos en 2 días distintos → Beto queda activo', !!(await prisma.user.findUnique({ where: { id: Beto.id } }))?.referidoActivadoEn)
    const bB = await bonos(Beto.id)
    check('Beto gana +20 mensajes, +10 dictados y +5 escaneos', bB.coach === 20 && bB.dictado === 10 && bB.escaneo === 5, bB)
    const bA = await bonos(Ana.id)
    check('Ana gana el mismo bono, más 20 mensajes del nivel de 1 amigo', bA.coach === 40 && bA.dictado === 10 && bA.escaneo === 5, bA)
    check('…y la insignia "Primer brote"', !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: Ana.id, badgeId: 'ref_primer_brote' } } })))
    await recordMissionAction(Beto.id, 'gasto_hormiga')
    check('Más movimientos no repiten el bono', (await bonos(Beto.id)).coach === 20 && (await bonos(Ana.id)).coach === 40)

    if (periodoBono() === periodoIA()) {
      const usoA = await call(Ana, 'GET', '/ai/uso')
      check('Kiri Coach de Ana (FREE): 10 del plan + 40 extra = 50 este mes', usoA.coach?.limite === 50 && usoA.coach?.extra === 40, usoA.coach)
      await prisma.aiUso.create({ data: { userId: Ana.id, periodo: periodoIA(), tipo: 'coach', cantidad: 12 } })
      const usoA2 = await call(Ana, 'GET', '/ai/uso')
      check('Con 12 mensajes usados (más que los 10 del plan) le quedan 38', usoA2.coach?.restantes === 38, usoA2.coach)
      const usage = await call(Ana, 'GET', '/usage-status')
      const ia = usage.variables?.find((v: any) => v.variableName === 'iaMensajesMes')
      check('Tu uso este mes: 12 de 50 mensajes (10 del plan + 40 extra)', ia?.currentCount === 12 && ia?.maxValue === 50 && ia?.extra === 40, ia)
    } else {
      console.log('SKIP  (fin de mes: el bono quedó para el mes siguiente)')
    }

    const misionAna = async (key: string) => (await prisma.missionProgress.findUnique({ where: { userId_missionKey_periodo: { userId: Ana.id, missionKey: key, periodo: 'referidos' } } }))?.progress ?? 0
    check('La misión "Tu primer amigo usa Kiri" de Ana se completa', (await misionAna('referido_1')) === 1)

    // ── Niveles: 3 amigos → 1 mes de su plan (Ana está en FREE → 30 días de PLUS) ──
    await amigoActivo('Caro', Ana.id)
    check('Con 2 amigos activos todavía no hay mes gratis', (await dias(Ana.id)) === 0)
    await amigoActivo('Dani', Ana.id)
    const dA3 = await dias(Ana.id)
    check('3 amigos activos → Ana (FREE) gana 30 días de KIRI PLUS', dA3 > 29.9 && dA3 <= 30.01, dA3.toFixed(2))
    invalidarPlan(Ana.id)
    const planAna = await call(Ana, 'GET', '/plan')
    check('Mi plan de Ana: 3 activos, siguiente premio en 5 (faltan 2) y el nivel de 3 logrado',
      planAna.referidos?.activos === 3 && planAna.referidos?.siguiente?.amigos === 5 && planAna.referidos?.siguiente?.faltanAmigos === 2
      && planAna.referidos?.niveles?.find((n: any) => n.amigos === 3)?.logrado === true,
      { activos: planAna.referidos?.activos, siguiente: planAna.referidos?.siguiente })
    check('…y muestra los premios ganados (bono por Beto, nivel 1 y nivel 3)', (planAna.referidos?.premios ?? []).length >= 3, planAna.referidos?.premios?.map((p: any) => p.premio))
    check('Ana ve la oferta para sus amigos: 14 días de prueba', planAna.referidos?.reglas?.pruebaAmigoDias === 14)

    // ── 10 amigos activos pero ninguno paga → todavía no hay PRO ──
    const extra: { id: string; correo: string }[] = []
    for (const n of ['Eva', 'Fer', 'Gabo', 'Hugo', 'Ines', 'Juan', 'Kike']) extra.push(await crear(n, { invitedById: Ana.id, isActive: true, referidoActivadoEn: new Date() }))
    await revisarNiveles(Ana.id)
    check('5 amigos → insignia "Jardinero social"', !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: Ana.id, badgeId: 'ref_jardinero_social' } } })))
    check('10 activos sin ninguno con plan pago → aún no gana los 3 meses de PRO', (await dias(Ana.id, 'pruebaProHasta')) === 0)

    // ── Momento 3: amigos que pagan ──
    const antes = await dias(Ana.id)
    const r1 = await pagada(extra[0], 'R-1')
    check('Eva paga → Ana (FREE) gana 1 mes: +30 días de PLUS', r1.referidoPremiado === true && Math.abs((await dias(Ana.id)) - antes - 30) < 0.05)
    await pagada(extra[0], 'R-1b')
    check('Una segunda factura de Eva no vuelve a premiar', Math.abs((await dias(Ana.id)) - antes - 30) < 0.05)
    await pagada(extra[1], 'R-2')
    const dPro = await dias(Ana.id, 'pruebaProHasta')
    check('10 activos y 2 con plan → 3 meses de KIRI PRO (90 días) e insignia Embajador', dPro > 89.9 && dPro <= 90.05
      && !!(await prisma.userBadge.findUnique({ where: { userId_badgeId: { userId: Ana.id, badgeId: 'ref_embajador' } } })), dPro.toFixed(2))
    invalidarPlan(Ana.id)
    const pAna = await resolverPlan(Ana.id)
    check('Ana usa KIRI PRO mientras duren (aunque también tenga días de PLUS)', pAna.tier === 'PRO' && pAna.fuente === 'prueba')

    // ── Quien ya paga recibe el mes gratis en su factura ──
    const Pedro = await crear('Pedro')
    contratos.set(Pedro.correo, 'KIRI PLUS')
    const Quin = await crear('Quin', { invitedById: Pedro.id, isActive: true })
    mesesPedidos.length = 0
    await pagada(Quin, 'Q-1')
    check('Pedro paga PLUS → Kiri pide 1 mes gratis en su contrato (con la clave interna)', mesesPedidos.length === 1 && mesesPedidos[0].correo === Pedro.correo && mesesPedidos[0].meses === 1 && mesesPedidos[0].conClave, mesesPedidos)
    check('…y no le presta días de PLUS (ya lo paga)', (await dias(Pedro.id)) === 0)
    const premioPedro = await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId: Pedro.id, clave: `pago:${Quin.id}` } } })
    check('…el premio dice "1 mes gratis de KIRI PLUS en tu próxima factura"', premioPedro?.premio === '1 mes gratis de KIRI PLUS en tu próxima factura' && premioPedro.estado === 'entregado', premioPedro?.premio)

    // ── Authoriza no responde: queda pendiente y se reintenta ──
    const Rosa = await crear('Rosa')
    contratos.set(Rosa.correo, 'KIRI PRO')
    freeMonthsCaido.add(Rosa.correo)
    const Saul = await crear('Saul', { invitedById: Rosa.id, isActive: true })
    await pagada(Saul, 'S-1')
    const pend = await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId: Rosa.id, clave: `pago:${Saul.id}` } } })
    check('Authoriza caído → el mes gratis de Rosa queda pendiente', pend?.estado === 'pendiente', pend?.estado)
    freeMonthsCaido.delete(Rosa.correo)
    mesesPedidos.length = 0
    await reintentarPendientes(Rosa.id)
    const ok = await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId: Rosa.id, clave: `pago:${Saul.id}` } } })
    check('…al reintentar se entrega en su factura', ok?.estado === 'entregado' && mesesPedidos.some(m => m.correo === Rosa.correo), ok?.estado)

    // ── Plan PRO ganado encima de un PLUS pagado ──
    const Tere = await crear('Tere', { pruebaProHasta: new Date(Date.now() + 10 * 86_400_000) })
    contratos.set(Tere.correo, 'KIRI PLUS')
    invalidarPlan(Tere.id)
    const pTere = await call(Tere, 'GET', '/plan')
    check('Tere paga PLUS y tiene meses de PRO ganados → usa PRO y Mi plan sabe que paga PLUS', pTere.tier === 'PRO' && pTere.tierContrato === 'PLUS', { tier: pTere.tier, tierContrato: pTere.tierContrato })

    // ── Seguridad ──
    const insignia = await call(Ana, 'POST', '/gamification/badges', { badgeId: 'ref_embajador' })
    check('Las insignias de invitar no se pueden pedir desde la app', insignia.status === 403)
    const Uli = await crear('Uli', { invitedById: Ana.id, isActive: false })
    await gasto(Uli.id, 1); await gasto(Uli.id); await gasto(Uli.id)
    await recordMissionAction(Uli.id, 'gasto_hormiga')
    check('Una cuenta sin verificar no cuenta como amigo activo', (await prisma.user.findUnique({ where: { id: Uli.id } }))?.referidoActivadoEn === null)
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
