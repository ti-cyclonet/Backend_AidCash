/**
 * Tarjeta de crédito: una compra a cuotas se cobra en el PRÓXIMO extracto.
 * Caso real: se pagó la cuota de la tarjeta este mes, luego se compró algo con
 * ella a cuotas y la tarjeta volvió a "Pago parcial" pidiendo la cuota de la
 * compra en el mismo mes. Monta las rutas en un puerto aparte con un usuario
 * temporal que se borra al final.
 *   npx tsx scripts/e2e-tarjeta.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4185
process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra).slice(0, 240) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { debtPeriodo } = await import('../src/lib/debt-calc.js')
  const app = express()
  app.use(express.json())
  app.use('/api/debts', (await import('../src/routes/debts.routes.js')).default)
  app.use('/api/impulse-expenses', (await import('../src/routes/impulse.routes.js')).default)
  app.use(errorHandler)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const correo = 'qa.me@kiri.test'
  const u = await prisma.user.create({ data: { nombre: 'Tania Tarjeta', correo: `tania-${stamp}@tarjeta.test`, username: `tania${stamp}`.slice(0, 20), passwordHash: 'x', onboardingDone: true, ingresoBase: 5000000, frecuenciaIngreso: 'mensual', diasPago: [30], cashBalance: 4000000, walletObligaciones: 2000000, walletLibre: 2000000 } })
  const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const tarjetaDe = async (id: string) => ((await call('GET', '/debts')).debts as any[]).find(d => d.id === id)

  try {
    const creada = await call('POST', '/debts', { nombre: 'TC Nu', montoTotal: 4203500, saldoRestante: 3400000, cuotaPeriodo: 798200, diasPago: '3', tipoDeuda: 'TARJETA_CREDITO', tasaInteres: 1.9 })
    const id = creada.debt?.id
    check('Tarjeta creada (cuota $798.200)', creada.status === 201 && !!id, creada.status)

    const pago = await call('POST', `/debts/${id}/pay`, { monto: 798200 })
    let t = await tarjetaDe(id)
    check('Se paga la cuota completa → Pagada', pago.status === 200 && t.pagadoEstePeriodo === true && t.cuotaPeriodo === 798200, { status: pago.status, cuota: t?.cuotaPeriodo, pagada: t?.pagadoEstePeriodo })

    const saldoAntes = t.saldoRestante
    const compra = await call('POST', '/impulse-expenses', { nombre: 'Audífonos', monto: 799169, tarjetaId: id, cuotas: 7 })
    t = await tarjetaDe(id)
    check('Compra a 7 cuotas con la tarjeta', compra.status === 201, compra.status)
    check('…la tarjeta SIGUE pagada este mes (la compra llega en el próximo extracto)', t.pagadoEstePeriodo === true && t.cuotaPeriodo === 798200, { cuota: t.cuotaPeriodo, pagada: t.pagadoEstePeriodo, abonado: t.montoPagadoEstePeriodo })
    check('…el saldo de la tarjeta sí sube con la compra', Math.abs(t.saldoRestante - (saldoAntes + 799169)) < 1, { antes: saldoAntes, ahora: t.saldoRestante })

    // El mes siguiente la cuota ya incluye la compra: se simula moviendo la
    // compra al periodo anterior
    const plan = await prisma.debtCardInstallment.findFirst({ where: { tarjetaId: id } })
    const mesPasado = new Date(); mesPasado.setDate(1); mesPasado.setMonth(mesPasado.getMonth() - 1)
    await prisma.debtCardInstallment.update({ where: { id: plan!.id }, data: { createdAt: mesPasado } })
    t = await tarjetaDe(id)
    check('Una compra del mes pasado SÍ suma a la cuota de este mes (798.200 + 114.167)', Math.abs(t.cuotaPeriodo - 912367) < 1, t.cuotaPeriodo)
    check('…y debt-calc la ubica en el periodo anterior', debtPeriodo(t, mesPasado) < debtPeriodo(t))
    await prisma.debtCardInstallment.update({ where: { id: plan!.id }, data: { createdAt: new Date() } })

    // Pagar con la tarjeta otra obligación: misma regla
    const arriendo = await call('POST', '/debts', { nombre: 'Préstamo moto', montoTotal: 3000000, cuotaPeriodo: 300000, diasPago: '20' })
    const pwc = await call('POST', '/debts/pay-with-card', { tarjetaId: id, monto: 300000, cuotas: 3, sourceType: 'debt', sourceId: arriendo.debt.id })
    t = await tarjetaDe(id)
    check('Pagar otra deuda con la tarjeta tampoco la saca de "Pagada" este mes', pwc.status === 200 && t.pagadoEstePeriodo === true && t.cuotaPeriodo === 798200 && pwc.tarjeta?.cuotaPeriodo === 798200, { status: pwc.status, cuota: t.cuotaPeriodo, resp: pwc.tarjeta?.cuotaPeriodo })

    // Tarjeta SIN pagar este mes y compra hoy: la cuota de hoy no cambia
    const otra = await call('POST', '/debts', { nombre: 'TC Visa', montoTotal: 1000000, cuotaPeriodo: 100000, diasPago: '25', tipoDeuda: 'TARJETA_CREDITO' })
    await call('POST', '/impulse-expenses', { nombre: 'Mercado', monto: 200000, tarjetaId: otra.debt.id, cuotas: 2 })
    const v = await tarjetaDe(otra.debt.id)
    check('Tarjeta sin pagar + compra hoy: la cuota de este mes sigue en $100.000', v.cuotaPeriodo === 100000 && v.pagadoEstePeriodo === false, v.cuotaPeriodo)
    const pagoV = await call('POST', `/debts/${otra.debt.id}/pay`, {})
    check('…pagar "la cuota" cobra $100.000 (no la compra de hoy)', pagoV.status === 200 && Math.abs(4000000 - 798200 - 100000 - Number((await prisma.user.findUnique({ where: { id: u.id } }))?.cashBalance)) < 1, pagoV.status)
  } finally {
    await prisma.user.deleteMany({ where: { id: u.id } })
    console.log(`\nUsuario temporal borrado; quedan: ${await prisma.user.count({ where: { id: u.id } })}`)
    server.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} pasaron`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
