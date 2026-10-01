/**
 * Prueba de nombre en partes y formas de recibir ingresos (fijo igual, fijo
 * que cambia por quincena, variable sin sueldo fijo), sin Authoriza real:
 * monta /api/auth y /api/users en un puerto aparte con un Authoriza simulado.
 * Crea usuarios temporales y los borra al final.
 *   npx tsx scripts/e2e-ingresos-perfil.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4194
const APP_PORT = 4193
const CLAVE = 'clave-interna-de-prueba-1234567890'
process.env.INTERNAL_API_KEY = CLAVE
process.env.AUTHORIZA_API_URL = `http://127.0.0.1:${MOCK_PORT}`

// correo → nombre en partes que "tiene" Authoriza
const nombres = new Map<string, Record<string, string | null>>()
const guardados: Record<string, unknown>[] = []
const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers['x-internal-key'] !== CLAVE) return json(401, { message: 'no' })
    const body = JSON.parse(data || '{}')
    if (req.url === '/api/auth/internal/person-name') return json(200, { name: nombres.get(body.email) ?? null })
    if (req.url === '/api/auth/internal/set-person-name') { guardados.push(body); nombres.set(body.email, body); return json(200, { ok: true }) }
    if (req.url === '/api/auth/internal/avatar') return json(200, { url: null })
    json(404, {})
  })
})

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { construirContexto } = await import('../src/lib/ai/contexto.js')
  const { normalizarAcciones } = await import('../src/lib/ai/acciones.js')
  const app = express()
  app.use(express.json())
  app.use('/api/auth', (await import('../src/routes/auth.routes.js')).default)
  app.use('/api/users', (await import('../src/routes/user.routes.js')).default)
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const crear = async (nombre: string, extra: Record<string, unknown> = {}) => {
    const correo = `${nombre.split(' ')[0].toLowerCase()}-${stamp}@ingresos.test`
    const u = await prisma.user.create({ data: { nombre, correo, username: `${nombre.split(' ')[0].toLowerCase()}${stamp}`, passwordHash: 'x', onboardingDone: true, ...extra } })
    ids.push(u.id)
    return { ...u, token: jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  }
  const call = async (u: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }

  try {
    // ── Nombre en partes ──
    const A = await crear('Alfredo José Mamby Jimenez')
    nombres.set(A.correo, { firstName: 'Alfredo', secondName: 'José', firstSurname: 'Mamby', secondSurname: 'Jimenez' })
    let me = (await call(A, 'GET', '/auth/me')).user
    check('Cuenta vieja: trae las partes del nombre desde Authoriza', me.primerNombre === 'Alfredo' && me.segundoNombre === 'José' && me.primerApellido === 'Mamby' && me.segundoApellido === 'Jimenez', me)
    check('…y las guarda en Kiri', (await prisma.user.findUnique({ where: { id: A.id } }))?.segundoNombre === 'José')

    const L = await crear('Laura Gómez Ruiz')
    me = (await call(L, 'GET', '/auth/me')).user
    check('Sin datos en Authoriza: 3 palabras = 1 nombre y 2 apellidos (sin guardarlo)', me.primerNombre === 'Laura' && !me.segundoNombre && me.primerApellido === 'Gómez' && me.segundoApellido === 'Ruiz' && !(await prisma.user.findUnique({ where: { id: L.id } }))?.primerNombre)

    const p = await call(L, 'PATCH', '/users/profile', { firstName: 'Laura', secondName: ' Sofía ', firstSurname: 'Gómez', secondSurname: '' })
    check('Guardar el perfil con segundo nombre', p.status === 200 && p.user.nombre === 'Laura Sofía Gómez' && p.user.segundoNombre === 'Sofía' && p.user.segundoApellido === null, p.user)
    check('…y se sincroniza con Authoriza por el canal interno', guardados.some(g => g.email === L.correo && g.secondName === 'Sofía' && g.firstSurname === 'Gómez'))
    me = (await call(L, 'GET', '/auth/me')).user
    check('Al volver a abrir el perfil sale el segundo nombre', me.segundoNombre === 'Sofía' && me.primerApellido === 'Gómez')
    await call(L, 'PATCH', '/users/profile', { nombre: 'Laura Sofía Gómez' })
    check('Guardar el mismo nombre completo no borra las partes', (await prisma.user.findUnique({ where: { id: L.id } }))?.segundoNombre === 'Sofía')
    await call(L, 'PATCH', '/users/profile', { nombre: 'Lau Gómez' })
    check('Cambiar el nombre completo por otro lado olvida las partes viejas', !(await prisma.user.findUnique({ where: { id: L.id } }))?.primerNombre)

    // ── Sueldo fijo que cambia por quincena ──
    const Q = await crear('Quique Pérez', { ingresoBase: 2000000, frecuenciaIngreso: 'quincenal', diasPago: [15, 30] })
    let r = await call(Q, 'PATCH', '/users/profile', { tipoIngreso: 'fijo', frecuenciaIngreso: 'quincenal', ingresoBase: 0, ingresoQuincena1: 1000000, ingresoQuincena2: 750000 })
    check('Quincenas distintas: 1.000.000 y 750.000 → al mes 1.750.000', r.status === 200 && Number(r.user.ingresoBase) === 1750000 && Number(r.user.ingresoQuincena1) === 1000000 && Number(r.user.ingresoQuincena2) === 750000, r.user)
    me = (await call(Q, 'GET', '/auth/me')).user
    check('/auth/me devuelve el monto de cada quincena', me.tipoIngreso === 'fijo' && Number(me.ingresoQuincena1) === 1000000 && Number(me.ingresoQuincena2) === 750000)
    const ctxQ = await construirContexto(Q.id)
    check('El coach sabe que las quincenas son distintas', /1\.000\.000 la 1\.ª quincena y \$750\.000 la 2\.ª/.test(ctxQ.usuario.descripcionIngreso), ctxQ.usuario.descripcionIngreso)
    const accQ = normalizarAcciones([
      { tipo: 'ingreso', nombre: 'Pago', monto: 750000 },
      { tipo: 'ingreso', nombre: 'Venta', monto: 300000 },
    ], ctxQ)
    check('Dictar "me pagaron 750 mil" = su sueldo (antes quedaba como extra)', accQ[0]?.tipoIngreso === 'salario' && accQ[1]?.tipoIngreso === 'extra', accQ.map(a => a.tipoIngreso))
    r = await call(Q, 'PATCH', '/users/profile', { ingresoQuincena1: 900000, ingresoQuincena2: 900000 })
    check('Si las dos quincenas son iguales se guardan como una sola (mes = 1.800.000)', Number(r.user.ingresoBase) === 1800000 && r.user.ingresoQuincena1 === null)
    await call(Q, 'PATCH', '/users/profile', { ingresoQuincena1: 1000000, ingresoQuincena2: 750000 })
    r = await call(Q, 'PATCH', '/users/profile', { frecuenciaIngreso: 'mensual' })
    check('Pasar a mensual quita los montos por quincena', r.user.frecuenciaIngreso === 'mensual' && r.user.ingresoQuincena1 === null)

    // ── Ingresos variables (sin sueldo fijo) ──
    const V = await crear('Valeria Independiente', { ingresoBase: 1500000, frecuenciaIngreso: 'quincenal', diasPago: [15, 30] })
    r = await call(V, 'PATCH', '/users/profile', { tipoIngreso: 'variable', ingresoBase: 0 })
    check('Variable: sin sueldo, mes calendario y sin días de pago', r.status === 200 && r.user.tipoIngreso === 'variable' && r.user.frecuenciaIngreso === 'mensual' && Number(r.user.ingresoBase) === 0, r.user)
    check('…días de pago quedan en el 1 (el mes completo)', JSON.stringify((await prisma.user.findUnique({ where: { id: V.id } }))?.diasPago) === '[1]')
    me = (await call(V, 'GET', '/auth/me')).user
    check('Sin ingresos registrados, el promedio es 0', me.ingresoPromedio === 0)
    const now = new Date()
    const mes = (k: number, dia: number) => new Date(now.getFullYear(), now.getMonth() - k, dia, 12)
    await prisma.incomeRecord.createMany({ data: [
      { userId: V.id, monto: 900000, tipo: 'salario', createdAt: mes(2, 5) },
      { userId: V.id, monto: 300000, tipo: 'salario', createdAt: mes(2, 20) },
      { userId: V.id, monto: 600000, tipo: 'salario', createdAt: mes(1, 10) },
      { userId: V.id, monto: 50000, tipo: 'salario', createdAt: mes(0, 1) },
    ] })
    me = (await call(V, 'GET', '/auth/me')).user
    check('Promedio real de los meses completos: (1.200.000 + 600.000) / 2 = 900.000', me.ingresoPromedio === 900000, me.ingresoPromedio)
    const ctxV = await construirContexto(V.id)
    check('El coach planea con ese promedio y sabe que no tiene sueldo fijo', ctxV.usuario.ingresoBase === 900000 && /ingresos variables/.test(ctxV.usuario.descripcionIngreso))
    const accV = normalizarAcciones([{ tipo: 'ingreso', nombre: 'Pago de un cliente', monto: 420000 }], ctxV)
    check('Con ingresos variables, lo que le entra por su trabajo es su ingreso principal', accV[0]?.tipoIngreso === 'salario')
    r = await call(V, 'PATCH', '/users/profile', { ingresoBase: 1200000 })
    const ctxV2 = await construirContexto(V.id)
    check('Si deja una estimación, se planea con ella', r.status === 200 && ctxV2.usuario.ingresoBase === 1200000)

    const N = await crear('Nuevo Variable', { tipoIngreso: 'variable' })
    await prisma.incomeRecord.create({ data: { userId: N.id, monto: 250000, tipo: 'salario' } })
    me = (await call(N, 'GET', '/auth/me')).user
    check('Primer mes (sin meses completos): el promedio es lo que lleva este mes', me.ingresoPromedio === 250000, me.ingresoPromedio)

    // ── Saldo inicial del test ("¿cuánta plata tienes hoy?") ──
    const S = await crear('Samuel Saldo', { tipoIngreso: 'fijo', ingresoBase: 3000000, cashBalance: 0 })
    await prisma.fixedExpense.create({ data: { userId: S.id, nombre: 'Arriendo', monto: 900000, fechaCorte: '5' } })
    const si = await call(S, 'POST', '/users/wallet/saldo-inicial', { monto: 2350000 })
    const sDb = await prisma.user.findUnique({ where: { id: S.id } })
    check('Saldo inicial: queda como Sueldo Real (cashBalance)', si.status === 201 && Number(sDb?.cashBalance) === 2350000, si)
    const bolsillos = Number(sDb?.walletAhorro) + Number(sDb?.walletObligaciones) + Number(sDb?.walletLibre) + Number(sDb?.walletEndeudamiento)
    check('…repartido en la billetera (obligaciones primero) y cuadra al peso', Math.abs(bolsillos - 2350000) < 1 && Number(sDb?.walletObligaciones) > 0, { bolsillos, obligaciones: Number(sDb?.walletObligaciones) })
    check('…NO es un ingreso (no va al historial ni al promedio)', (await prisma.incomeRecord.count({ where: { userId: S.id } })) === 0)
    const mision = await prisma.missionProgress.findFirst({ where: { userId: S.id, missionKey: 'registrar_ingreso_real' } })
    check('…y cumple "Registra tu sueldo real"', !!mision && mision.progress >= mision.target, mision)
    const si2 = await call(S, 'POST', '/users/wallet/saldo-inicial', { monto: 100000 })
    check('Con saldo ya puesto no se puede pisar (409)', si2.status === 409 && Number((await prisma.user.findUnique({ where: { id: S.id } }))?.cashBalance) === 2350000, si2)
    const C = await crear('Carla Doble', { cashBalance: 0 })
    const dobles = await Promise.all([1, 2, 3].map(() => call(C, 'POST', '/users/wallet/saldo-inicial', { monto: 500000 })))
    check('Triple envío a la vez: solo cuenta uno', dobles.filter(d => d.status === 201).length === 1 && Number((await prisma.user.findUnique({ where: { id: C.id } }))?.cashBalance) === 500000, dobles.map(d => d.status))
    check('Monto 0 o negativo → 400', (await call(S, 'POST', '/users/wallet/saldo-inicial', { monto: 0 })).status === 400 && (await call(S, 'POST', '/users/wallet/saldo-inicial', { monto: -5 })).status === 400)
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
