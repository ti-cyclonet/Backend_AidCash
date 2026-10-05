/**
 * Minijuego del árbol (lib/jardin-juego.ts): frutos por movimientos reales,
 * sacudida y riego una vez al día, XP validada en el servidor.
 * Rutas en un puerto aparte (sin crons), usuario temporal que se borra al final.
 *   npx tsx scripts/e2e-jardin.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4177
const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { esDorado } = await import('../src/lib/jardin-juego.js')
  const { periodoIA } = await import('../src/middleware/limit-enforcement.js')
  const app = express()
  app.use(express.json())
  app.use('/api/gamification', (await import('../src/routes/gamification.routes.js')).default)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const correo = `jardin-${stamp}@jardin.test`
  const u = await prisma.user.create({ data: { nombre: 'Jardín Prueba', correo, username: `jardin${stamp}`, passwordHash: 'x', onboardingDone: true } })
  const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/gamification${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const gasto = () => prisma.impulseExpense.create({ data: { userId: u.id, nombre: 'Pan', monto: 3000, periodo: periodoIA() } as any })
  const xpJardin = async () => (await prisma.user.findUnique({ where: { id: u.id }, select: { xpFromJardin: true } }))?.xpFromJardin ?? 0

  try {
    // Antes del nivel 4 (4.350 XP) el árbol no da frutos
    const bloqueado = await call('GET', '/jardin')
    check('Árbol nuevo (nivel 1): sin frutos, pero sí sacudida y riego', bloqueado.frutosDesbloqueados === false && bloqueado.frutos?.length === 0 && bloqueado.nivelFrutos === 4 && bloqueado.regado === false)
    check('…y no se puede cosechar pidiéndolo directo', (await call('POST', '/jardin/cosechar', { indice: 0 })).status === 403)
    await prisma.user.update({ where: { id: u.id }, data: { xpFromMissions: 4400 } })

    const e0 = await call('GET', '/jardin')
    check('Con nivel 4 se desbloquean los frutos', e0.frutosDesbloqueados === true)
    check('Sin movimientos hoy: 1 fruto por visitar, sin sacudir ni regar', e0.frutos?.length === 1 && e0.sacudida === null && e0.regado === false && e0.frutosPorGanar === 4, { frutos: e0.frutos?.length, porGanar: e0.frutosPorGanar })
    check('Los frutos dorados son fijos por día (no se pueden volver a tirar)', e0.frutos[0].dorado === esDorado(u.id, e0.fecha, 0))

    const noCrecio = await call('POST', '/jardin/cosechar', { indice: 1 })
    check('Un fruto que aún no crece no se puede cosechar', noCrecio.status === 400)
    const c0 = await call('POST', '/jardin/cosechar', { indice: 0 })
    const xp0 = e0.frutos[0].dorado ? 10 : 3
    check('Cosechar el fruto da +3 XP (dorado +10)', c0.ok && c0.xp === xp0 && (await xpJardin()) === xp0, c0)
    check('El mismo fruto no se cosecha dos veces', (await call('POST', '/jardin/cosechar', { indice: 0 })).status === 409)

    await gasto(); await gasto()
    const e1 = await call('GET', '/jardin')
    check('2 movimientos hoy → 3 frutos (el primero ya cosechado)', e1.frutos?.length === 3 && e1.frutos[0].cosechado === true && e1.frutos[1].cosechado === false)
    for (let i = 0; i < 6; i++) await gasto()
    const e2 = await call('GET', '/jardin')
    check('Hasta 5 frutos al día, aunque haya más movimientos', e2.frutos?.length === 5 && e2.frutosPorGanar === 0)

    // Boost x2 activo: el fruto vale doble
    await prisma.user.update({ where: { id: u.id }, data: { xpBoostExpiresAt: new Date(Date.now() + 3_600_000) } })
    const c1 = await call('POST', '/jardin/cosechar', { indice: 1 })
    check('Con XP x2 activo el fruto vale doble', c1.ok && c1.doble === true && c1.xp === (e2.frutos[1].dorado ? 20 : 6), c1)
    await prisma.user.update({ where: { id: u.id }, data: { xpBoostExpiresAt: null } })

    const antes = await xpJardin()
    const s = await call('POST', '/jardin/sacudir')
    check('Sacudir el árbol da un premio sorpresa', s.ok && (s.tipo === 'boost' || s.xp > 0) && !!s.etiqueta, s)
    check('…y su XP se suma al jardín', (await xpJardin()) === antes + (s.xp ?? 0))
    check('Solo se sacude una vez al día', (await call('POST', '/jardin/sacudir')).status === 409)

    const antesRiego = await xpJardin()
    const boostDeSacudida = s.tipo === 'boost'
    const r = await call('POST', '/jardin/regar')
    check('Regar da +5 XP (x2 si la sacudida dio boost)', r.ok && r.xp === (boostDeSacudida ? 10 : 5) && (await xpJardin()) === antesRiego + r.xp, r)
    check('Solo se riega una vez al día', (await call('POST', '/jardin/regar')).status === 409)

    const e3 = await call('GET', '/jardin')
    check('El estado del día lo refleja todo (sacudida, riego y XP de hoy)', e3.regado === true && !!e3.sacudida && e3.xpHoy === (await xpJardin()), { xpHoy: e3.xpHoy })
    const st = await call('GET', '/status')
    check('/gamification/status trae la XP del jardín para el nivel del árbol', st.xpFromJardin === (await xpJardin()))
  } finally {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {})
    console.log(`\nUsuario temporal borrado; quedan: ${await prisma.user.count({ where: { id: u.id } })}`)
    server.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} pasaron`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
