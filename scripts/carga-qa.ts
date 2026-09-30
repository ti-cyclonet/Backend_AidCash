/**
 * Prueba de carga con volumen realista: crea ~1.500 usuarios temporales con
 * historial (≈370 mil filas), levanta scripts/carga-servidor.ts en otro proceso
 * y mide latencias (p50/p95/p99) de los endpoints que abre cada pantalla con
 * muchos usuarios a la vez. Al final borra todo lo creado.
 *   npx tsx scripts/carga-qa.ts            (sembrar + medir + borrar)
 *   npx tsx scripts/carga-qa.ts borrar     (solo borrar restos de una corrida anterior)
 */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PUERTO = 4189
const USUARIOS = Number(process.env.CARGA_USUARIOS ?? 1500)
const CONCURRENCIA = Number(process.env.CARGA_CONCURRENCIA ?? 50)
const DOMINIO = '@carga.test'

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const borrar = async () => {
    const t = Date.now()
    const r = await prisma.user.deleteMany({ where: { correo: { endsWith: DOMINIO } } })
    console.log(`Borrados ${r.count} usuarios de carga (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  }
  if (process.argv[2] === 'borrar') { await borrar(); await prisma.$disconnect(); return }
  await borrar()

  // ── Sembrar volumen ──
  const t0 = Date.now()
  const meses = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setMonth(d.getMonth() - i); return d })
  const per = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const ids: string[] = []
  const lote = async <T>(modelo: { createMany: (a: { data: T[] }) => Promise<unknown> }, filas: T[]) => { for (let i = 0; i < filas.length; i += 5000) await modelo.createMany({ data: filas.slice(i, i + 5000) }) }
  const users = [], debts = [], debtPays = [], fijos = [], fijoPays = [], gastos = [], ingresos = [], cats = [], bolsillos = [], ahorros = [], avisos = []
  for (let u = 0; u < USUARIOS; u++) {
    const id = randomUUID(); ids.push(id)
    users.push({ id, nombre: `Carga ${u}`, correo: `carga${u}${DOMINIO}`, username: `carga_${u}_${Date.now() % 100000}`, passwordHash: 'x', onboardingDone: true, ingresoBase: 3000000, frecuenciaIngreso: 'quincenal', diasPago: [15, 30], cashBalance: 1500000, walletLibre: 1500000 })
    const catIds = Array.from({ length: 5 }, (_, i) => { const cid = randomUUID(); cats.push({ id: cid, userId: id, nombre: `Cat ${i}`, montoLimite: 300000 }); return cid })
    for (let i = 0; i < 4; i++) {
      const did = randomUUID()
      debts.push({ id: did, userId: id, nombre: `Deuda ${i}`, montoTotal: 5000000, saldoRestante: 3000000, cuotaPeriodo: 250000, diasPago: String(5 + i * 5), tasaInteres: 1.5 })
      for (const m of meses) debtPays.push({ debtId: did, montoPagado: 250000, abonoCapital: 200000, pagoInteres: 50000, saldoAnterior: 3200000, saldoPosterior: 3000000, periodo: per(m), createdAt: m })
    }
    for (let i = 0; i < 4; i++) {
      const fid = randomUUID()
      fijos.push({ id: fid, userId: id, nombre: `Fijo ${i}`, monto: 120000, fechaCorte: String(3 + i * 6), budgetCategoryId: catIds[i] })
      for (const m of meses) fijoPays.push({ fixedExpenseId: fid, montoPagado: 120000, periodo: per(m), createdAt: m })
    }
    for (const m of meses) {
      for (let g = 0; g < 20; g++) gastos.push({ userId: id, nombre: `Gasto ${g}`, monto: 5000 + g * 1000, categoria: 'otro', periodo: per(m), esHormiga: g % 3 === 0, budgetCategoryId: catIds[g % 5], createdAt: new Date(m.getTime() - g * 3600000) })
      ingresos.push({ userId: id, monto: 1500000, tipo: 'salario', createdAt: m }, { userId: id, monto: 1500000, tipo: 'salario', createdAt: new Date(m.getTime() - 15 * 86400000) })
      ahorros.push({ userId: id, periodo: per(m), monto: 100000, tipo: 'ahorro', createdAt: m })
      for (let n = 0; n < 5; n++) avisos.push({ userId: id, event: 'info', data: { title: 'Aviso', message: 'Mensaje de prueba' }, createdAt: new Date(m.getTime() - n * 86400000) })
    }
    bolsillos.push({ userId: id, nombre: 'Viaje', meta: 2000000, montoActual: 400000 }, { userId: id, nombre: 'Colchón', meta: 0, montoActual: 100000 })
  }
  await lote(prisma.user, users); await lote(prisma.budgetCategory, cats); await lote(prisma.debt, debts); await lote(prisma.debtPayment, debtPays)
  await lote(prisma.fixedExpense, fijos); await lote(prisma.fixedExpensePayment, fijoPays); await lote(prisma.impulseExpense, gastos)
  await lote(prisma.incomeRecord, ingresos); await lote(prisma.savingsHistory, ahorros); await lote(prisma.savingsPocket, bolsillos)
  await lote(prisma.notification as never, avisos as never[])
  const filas = users.length + cats.length + debts.length + debtPays.length + fijos.length + fijoPays.length + gastos.length + ingresos.length + ahorros.length + bolsillos.length + avisos.length
  console.log(`Sembradas ${filas.toLocaleString('es-CO')} filas para ${USUARIOS} usuarios en ${((Date.now() - t0) / 1000).toFixed(1)} s`)

  // ── Servidor en otro proceso ──
  const srv = spawn(process.execPath, ['--import', 'tsx', 'scripts/carga-servidor.ts'], { env: { ...process.env, CARGA_PUERTO: String(PUERTO) }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((ok, mal) => { srv.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('LISTO')) ok() }); srv.on('exit', c => mal(new Error(`servidor salió ${c}`))) })

  const tokens = ids.slice(0, 300).map(id => jwt.sign({ userId: id, correo: 'x@carga.test' }, process.env.JWT_SECRET!, { expiresIn: '1h' }))
  const rutas = [
    '/auth/me', '/users/wallet', '/debts?estado=activa', '/fixed-expenses', '/impulse-expenses?limit=1000', '/impulse-expenses/top-consumos',
    '/budget-categories', '/budget-categories/resumen', '/extra-incomes', '/savings?limit=12', '/notifications', '/plan', '/plan/welcome',
    '/gamification/status', '/projections/spending', '/missions', '/reports/balance?timeframe=month', '/users/dashboard-summary', '/savings-pockets',
  ]
  const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
  const medir = (nombre: string, total: number, hacer: (i: number) => Promise<number>) => medirCon(CONCURRENCIA, nombre, total, hacer)
  const medirCon = async (concurrencia: number, nombre: string, total: number, hacer: (i: number) => Promise<number>) => {
    const lat: number[] = []; let errores = 0; let i = 0
    const motivos: Record<string, number> = {}
    const t = Date.now()
    await Promise.all(Array.from({ length: concurrencia }, async () => {
      while (i < total) {
        const n = i++; const s = performance.now()
        try { const st = await hacer(n); if (st >= 400) { errores++; motivos[`HTTP ${st}`] = (motivos[`HTTP ${st}`] ?? 0) + 1 } } catch (e) { errores++; const m = String((e as Error).cause ?? (e as Error).message).slice(0, 80); motivos[m] = (motivos[m] ?? 0) + 1 }
        lat.push(performance.now() - s)
      }
    }))
    lat.sort((a, b) => a - b)
    const seg = (Date.now() - t) / 1000
    console.log(`${nombre.padEnd(34)} p50 ${pct(lat, .5).toFixed(0).padStart(5)} ms · p95 ${pct(lat, .95).toFixed(0).padStart(5)} · p99 ${pct(lat, .99).toFixed(0).padStart(5)} · ${(total / seg).toFixed(0).padStart(4)} req/s · errores ${errores}${errores ? ' ' + JSON.stringify(motivos) : ''}`)
    return { p95: pct(lat, .95), errores }
  }
  // Conexiones keep-alive reutilizadas (hasta 128), como nginx con `keepalive`
  // hacia Node. Abrir una conexión nueva por petición medía el límite de
  // conexiones de Windows, no la capacidad del backend.
  const agente = new http.Agent({ keepAlive: true, maxSockets: 128 })
  const get = (ruta: string, n: number) => new Promise<number>((ok, mal) => {
    const req = http.get({ host: '127.0.0.1', port: PUERTO, path: `/api${ruta}`, agent: agente, headers: { Authorization: `Bearer ${tokens[n % tokens.length]}` } }, res => {
      let txt = ''
      res.on('data', d => { txt += d })
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 500 && process.env.CARGA_DETALLE) console.log('  500 en', ruta, txt.slice(0, 160))
        ok(res.statusCode ?? 0)
      })
    })
    req.on('error', mal)
  })
  // Solo el escenario de pantalla completa, sin la batería por endpoint (más rápido para diagnosticar)
  if (process.env.CARGA_SOLO_PANTALLA) rutas.length = 0

  try {
    console.log(`\n── Endpoint por endpoint (${CONCURRENCIA} a la vez, 400 peticiones c/u) ──`)
    const res: Record<string, { p95: number; errores: number }> = {}
    for (const r of rutas) res[r] = await medir(r, 400, n => get(r, n))
    // Las 15 llamadas distintas que hace de verdad el Dashboard (medidas en el navegador)
    const dashboard = ['/auth/me', '/projections/spending', '/budget-categories', '/budget-categories/resumen', '/impulse-expenses/top-consumos',
      '/gamification/status', '/users/wallet', '/debts?estado=activa', '/fixed-expenses', '/savings?limit=12', '/extra-incomes',
      '/impulse-expenses?limit=1000', '/notifications', '/plan/welcome', '/plan']
    console.log(`\n── Pantalla completa: usuarios abriendo el Dashboard a la vez (${dashboard.length} llamadas c/u) ──`)
    for (const usuarios of [25, 50, 100]) {
      // Como un navegador: como mucho 6 conexiones a la vez por usuario (antes
      // se abrían las 15 juntas y Windows rechazaba conexiones: ECONNREFUSED)
      await medirCon(usuarios, `Dashboard (${usuarios} a la vez)`, usuarios * 4, async n => {
        const cola = [...dashboard]; let peor = 0
        await Promise.all(Array.from({ length: 6 }, async () => { for (let r = cola.shift(); r; r = cola.shift()) peor = Math.max(peor, await get(r, n)) }))
        return peor
      })
    }
    const lentos = Object.entries(res).filter(([, v]) => v.p95 > 500)
    console.log(lentos.length ? `\nLENTOS (p95 > 500 ms): ${lentos.map(([k, v]) => `${k} ${v.p95.toFixed(0)}ms`).join(', ')}` : '\nNingún endpoint pasó de 500 ms en p95')
  } finally {
    srv.kill()
    await borrar()
    await prisma.$disconnect()
  }
}
main().catch(async e => { console.error(e); process.exit(1) })
