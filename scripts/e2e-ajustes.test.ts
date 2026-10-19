/**
 * Ajustes del 2026-10-18: subir/bajar un préstamo de Social, una deuda ("me
 * prestaron más") y la meta de un ahorro compartido; ingreso extra con
 * descripción; "Pago total" de una deuda; saldadas visibles solo 7 días.
 * Rutas en un puerto aparte (sin crons), usuarios temporales que se borran al final.
 *   npx tsx scripts/e2e-ajustes.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4178
const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const app = express()
  app.use(express.json())
  app.use('/api/loans', (await import('../src/routes/loans.routes.js')).default)
  app.use('/api/debts', (await import('../src/routes/debts.routes.js')).default)
  app.use('/api/shared-pockets', (await import('../src/routes/shared-pockets.routes.js')).default)
  app.use('/api/users', (await import('../src/routes/user.routes.js')).default)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const crear = (n: string) => prisma.user.create({ data: { nombre: `${n} Prueba`, correo: `${n}-${stamp}@ajustes.test`, username: `${n}${stamp}`, passwordHash: 'x', onboardingDone: true, cashBalance: 1_000_000, walletLibre: 1_000_000 } })
  const A = await crear('ana')
  const B = await crear('beto')
  const token = (u: { id: string; correo: string }) => jwt.sign({ userId: u.id, correo: 'qa.me@kiri.test' }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (u: { id: string; correo: string }, method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(u)}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const cash = async (id: string) => Number((await prisma.user.findUnique({ where: { id }, select: { cashBalance: true } }))?.cashBalance)

  let pocketId: string | null = null
  try {
    // ── Préstamo de Social: A le prestó a B ──
    await prisma.connection.create({ data: { requesterId: A.id, addresseeId: B.id, status: 'ACCEPTED', role: 'FRIEND' } })
    const loan = await prisma.loan.create({ data: { lenderId: A.id, borrowerId: B.id, amount: 100_000, remainingAmount: 100_000, montoOriginal: 100_000, status: 'ACTIVE', sinDesembolso: true, creadoPorId: A.id } })

    const antesB = await cash(B.id)
    const r1 = await call(B, 'POST', `/loans/${loan.id}/ajustar`, { tipo: 'aumentar', monto: 50_000, nota: 'para el mercado', enMiSaldo: true })
    check('Quien debe puede subir el préstamo (me prestó más)', r1.status === 200 && r1.loan.remainingAmount === 150_000 && r1.loan.amount === 150_000, r1)
    check('…y si marcó "entró a mi saldo", le suma a SU billetera', (await cash(B.id)) === antesB + 50_000)
    check('Quien debe NO puede bajarlo (tiene que abonar)', (await call(B, 'POST', `/loans/${loan.id}/ajustar`, { tipo: 'disminuir', monto: 10_000 })).status === 403)

    const antesA = await cash(A.id)
    const r2 = await call(A, 'POST', `/loans/${loan.id}/ajustar`, { tipo: 'disminuir', monto: 30_000 })
    check('Quien prestó puede bajarlo', r2.status === 200 && r2.loan.remainingAmount === 120_000, r2.loan)
    check('Bajar no mueve billeteras', (await cash(A.id)) === antesA)
    check('No se puede bajar más de lo que falta', (await call(A, 'POST', `/loans/${loan.id}/ajustar`, { tipo: 'disminuir', monto: 999_999 })).status === 400)
    const r3 = await call(A, 'POST', `/loans/${loan.id}/ajustar`, { tipo: 'disminuir', monto: 120_000 })
    check('Bajarlo a 0 lo deja saldado (PAID)', r3.loan?.status === 'PAID', r3.loan?.status)

    // ── Deuda: "me prestaron más" / bajar ──
    const debt = await prisma.debt.create({ data: { userId: A.id, nombre: 'Préstamo tío', montoTotal: 200_000, saldoRestante: 200_000, cuotaPeriodo: 50_000, diasPago: '15', tipoDeuda: 'PRESTAMO' } as any })
    const d1 = await call(A, 'POST', `/debts/${debt.id}/ajustar-monto`, { tipo: 'aumentar', monto: 100_000 })
    check('Me prestaron más: suben total y saldo', d1.status === 200 && d1.debt.montoTotal === 300_000 && d1.debt.saldoRestante === 300_000, d1.debt && { total: d1.debt.montoTotal, saldo: d1.debt.saldoRestante })
    const d2 = await call(A, 'POST', `/debts/${debt.id}/ajustar-monto`, { tipo: 'disminuir', monto: 50_000 })
    check('Bajar la deuda', d2.debt?.saldoRestante === 250_000 && d2.debt?.montoTotal === 250_000)
    check('El ajuste queda registrado (ampliacion + reduccion)', (await prisma.debtAjuste.count({ where: { debtId: debt.id } })) === 2)
    check('La deuda trae "pagoTotal" (saldo + interés del periodo)', d2.debt?.pagoTotal === 250_000, d2.debt?.pagoTotal)
    check('Otro usuario no puede ajustarla', (await call(B, 'POST', `/debts/${debt.id}/ajustar-monto`, { tipo: 'aumentar', monto: 1 })).status === 404)

    // ── Saldadas: solo 7 días en la lista ──
    const vieja = await prisma.debt.create({ data: { userId: A.id, nombre: 'Vieja', montoTotal: 10_000, saldoRestante: 0, cuotaPeriodo: 10_000, diasPago: '1', estado: 'saldada' } as any })
    const nueva = await prisma.debt.create({ data: { userId: A.id, nombre: 'Nueva', montoTotal: 10_000, saldoRestante: 0, cuotaPeriodo: 10_000, diasPago: '1', estado: 'saldada' } as any })
    await prisma.$executeRaw`UPDATE debts SET updated_at = NOW() - INTERVAL '8 days' WHERE id = ${vieja.id}`
    const sal = await call(A, 'GET', '/debts?estado=saldada')
    const ids = (sal.debts ?? []).map((d: { id: string }) => d.id)
    check('Saldada hace 8 días ya no sale; la reciente sí', !ids.includes(vieja.id) && ids.includes(nueva.id), ids.length)
    check('…pero la fila sigue en la base (sus pagos no se pierden)', (await prisma.debt.count({ where: { id: vieja.id } })) === 1)

    // ── Ahorro compartido: subir/bajar meta ──
    const pocket = await prisma.sharedPocket.create({ data: { nombre: 'Viaje', meta: 500_000, members: { create: [{ userId: A.id, role: 'owner' }, { userId: B.id }] } } })
    pocketId = pocket.id
    const p1 = await call(B, 'PATCH', `/shared-pockets/${pocket.id}`, { meta: 800_000 })
    check('Cualquier miembro sube la meta', p1.status === 200 && p1.pocket.meta === 800_000, p1)
    const extraño = await crear('carla')
    check('Alguien que no es miembro no puede', (await call(extraño, 'PATCH', `/shared-pockets/${pocket.id}`, { meta: 1 })).status === 404)
    await prisma.user.delete({ where: { id: extraño.id } })

    // ── Ingreso extra con descripción ──
    const inc = await call(A, 'POST', '/users/wallet/income', { monto: 65_338, tipo: 'extra', descripcion: 'Venta del celular' })
    check('El ingreso extra guarda su descripción', inc.status < 300 && inc.record?.descripcion === 'Venta del celular', inc.record?.descripcion ?? inc)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [A.id, B.id] } } }).catch(() => {})
    if (pocketId) await prisma.sharedPocket.delete({ where: { id: pocketId } }).catch(() => {})
    console.log(`\nUsuarios temporales borrados; quedan: ${await prisma.user.count({ where: { correo: { endsWith: `${stamp}@ajustes.test` } } })}`)
    server.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} pasaron`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
