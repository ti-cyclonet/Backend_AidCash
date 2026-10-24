/**
 * Avance de tarjeta de crédito + cuotas de los planes de la tarjeta.
 *  - El avance suma el monto a la billetera y deja en la tarjeta monto +
 *    comisión, dividido en las cuotas elegidas (desde el próximo extracto).
 *  - Pagar la cuota del mes abona a cada plan SOLO su cuota: antes el pago
 *    entero se iba al plan más antiguo y una compra a 6 cuotas quedaba
 *    "pagada" con la primera.
 *  - Tarjeta quincenal: cada quincena cobra la mitad de la cuota mensual.
 * Monta las rutas en un puerto aparte con un usuario temporal que se borra al final.
 *   npx tsx scripts/e2e-avance-tarjeta.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4186
process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra).slice(0, 240) : ''}`) }
const cerca = (a: number, b: number) => Math.abs(a - b) < 1

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { ingresoPromedioMensual } = await import('../src/lib/ingresos.js')
  const app = express()
  app.use(express.json())
  app.use('/api/debts', (await import('../src/routes/debts.routes.js')).default)
  app.use('/api/users', (await import('../src/routes/user.routes.js')).default)
  app.use(errorHandler)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const correo = 'qa.me@kiri.test'
  const u = await prisma.user.create({ data: { nombre: 'Andrés Avance', correo: `andres-${stamp}@avance.test`, username: `avance${stamp}`.slice(0, 20), passwordHash: 'x', onboardingDone: true, ingresoBase: 4000000, frecuenciaIngreso: 'mensual', diasPago: [30], cashBalance: 2000000, walletObligaciones: 1000000, walletLibre: 1000000 } })
  const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const tarjetaDe = async (id: string) => ((await call('GET', '/debts')).debts as any[]).find(d => d.id === id)
  const caja = async () => Number((await prisma.user.findUnique({ where: { id: u.id } }))!.cashBalance)
  const mesPasado = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d }

  try {
    const creada = await call('POST', '/debts', { nombre: 'TC Visa', montoTotal: 5000000, saldoRestante: 1000000, cuotaPeriodo: 300000, diasPago: '15', tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 5000000 })
    const id = creada.debt?.id
    check('Tarjeta creada (saldo $1.000.000, cuota $300.000)', creada.status === 201 && !!id, creada.status)

    // ── Avance ──
    const cajaAntes = await caja()
    const av = await call('POST', '/users/wallet/avance-tarjeta', { tarjetaId: id, monto: 600000, cuotas: 6, comision: 18000, descripcion: 'Arreglo del carro' })
    let t = await tarjetaDe(id)
    check('Avance de $600.000 a 6 cuotas con $18.000 de comisión', av.status === 201 && av.record?.tipo === 'avance', { status: av.status, err: av.error })
    check('…la billetera sube SOLO el monto ($600.000, sin la comisión)', cerca(await caja(), cajaAntes + 600000), { antes: cajaAntes, ahora: await caja() })
    check('…la tarjeta debe monto + comisión ($1.618.000)', cerca(t.saldoRestante, 1618000), t.saldoRestante)
    const plan = await prisma.debtCardInstallment.findFirst({ where: { tarjetaId: id } })
    check('…plan de 6 cuotas de $103.000 ((600.000 + 18.000) / 6)', plan && cerca(Number(plan.cuotaMensual), 103000) && plan.cuotasTotal === 6, { cuota: Number(plan?.cuotaMensual), cuotas: plan?.cuotasTotal })
    check('…este mes la cuota no cambia (llega en el próximo extracto)', t.cuotaPeriodo === 300000, t.cuotaPeriodo)
    check('…la respuesta trae la tarjeta actualizada', cerca(av.tarjeta?.saldoRestante, 1618000), av.tarjeta?.saldoRestante)
    check('…el avance no cuenta como ingreso en el promedio', (await ingresoPromedioMensual(u.id)) === 0, await ingresoPromedioMensual(u.id))

    const otraDeuda = await call('POST', '/debts', { nombre: 'Préstamo', montoTotal: 1000000, cuotaPeriodo: 100000, diasPago: '20' })
    const avMal = await call('POST', '/users/wallet/avance-tarjeta', { tarjetaId: otraDeuda.debt.id, monto: 100000, cuotas: 1 })
    check('Un avance sobre algo que no es tarjeta de crédito → 404', avMal.status === 404, avMal.status)

    // ── El mes siguiente: la cuota suma la cuota del avance ──
    await prisma.debtCardInstallment.update({ where: { id: plan!.id }, data: { createdAt: mesPasado() } })
    t = await tarjetaDe(id)
    check('Mes siguiente: cuota = 300.000 + 103.000', cerca(t.cuotaPeriodo, 403000), t.cuotaPeriodo)

    const pago = await call('POST', `/debts/${id}/pay`, { monto: 403000 })
    let p = await prisma.debtCardInstallment.findUnique({ where: { id: plan!.id } })
    check('Pagar la cuota abona al avance SOLO su cuota ($103.000), no el pago entero', pago.status === 200 && cerca(Number(p!.montoAbonado), 103000), { status: pago.status, abonado: Number(p?.montoAbonado) })

    // Un abono extra en el mismo periodo baja el saldo "base", no adelanta el plan
    await call('POST', `/debts/${id}/pay`, { monto: 500000 })
    p = await prisma.debtCardInstallment.findUnique({ where: { id: plan!.id } })
    check('Abono extra de $500.000 → va al saldo sin plan; el avance sigue en 1 de 6', cerca(Number(p!.montoAbonado), 103000), Number(p?.montoAbonado))

    // El mes siguiente el plan sigue sumando su cuota (no "desaparece")
    await prisma.debtPayment.updateMany({ where: { debtId: id }, data: { periodo: '2000-01' } })
    t = await tarjetaDe(id)
    check('…y el mes siguiente la cuota sigue incluyendo el avance (300.000 + 103.000)', cerca(t.cuotaPeriodo, 403000), t.cuotaPeriodo)

    // Pagar el total de la tarjeta sí liquida el plan
    const total = t.saldoRestante
    await call('POST', `/debts/${id}/pay`, { monto: total })
    p = await prisma.debtCardInstallment.findUnique({ where: { id: plan!.id } })
    t = await tarjetaDe(id)
    check('Pagar el total de la tarjeta liquida el avance', cerca(Number(p!.montoAbonado), 618000) && cerca(t.saldoRestante, 0), { abonado: Number(p?.montoAbonado), saldo: t.saldoRestante })

    // Deshacer el pago devuelve lo abonado al plan
    const undo = await call('POST', `/debts/${id}/undo-pay`, { alcance: 'ultimo' })
    p = await prisma.debtCardInstallment.findUnique({ where: { id: plan!.id } })
    check('Deshacer ese pago le devuelve al plan lo abonado', undo.status === 200 && cerca(Number(p!.montoAbonado), 103000), { status: undo.status, abonado: Number(p?.montoAbonado), err: undo.error })

    // ── Eliminar un avance revierte la billetera y la tarjeta ──
    const saldoT = (await tarjetaDe(id)).saldoRestante
    const cajaT = await caja()
    const av2 = await call('POST', '/users/wallet/avance-tarjeta', { tarjetaId: id, monto: 200000, cuotas: 2, comision: 10000 })
    const del = await call('DELETE', `/users/wallet/income/${av2.record.id}`)
    t = await tarjetaDe(id)
    check('Eliminar un avance: la billetera y la tarjeta vuelven a como estaban', del.status === 200 && cerca(await caja(), cajaT) && cerca(t.saldoRestante, saldoT), { status: del.status, caja: [cajaT, await caja()], tarjeta: [saldoT, t.saldoRestante] })
    check('…y su plan de cuotas desaparece', (await prisma.debtCardInstallment.count({ where: { id: av2.record.installmentId } })) === 0)

    // ── Tarjeta quincenal: cada quincena cobra la mitad de la cuota mensual ──
    const q = await call('POST', '/debts', { nombre: 'TC Quincenal', montoTotal: 3000000, saldoRestante: 500000, cuotaPeriodo: 50000, diasPago: '5,20', frecuenciaPago: 'quincenal', tipoDeuda: 'TARJETA_CREDITO' })
    await call('POST', '/users/wallet/avance-tarjeta', { tarjetaId: q.debt.id, monto: 400000, cuotas: 2, comision: 0 })
    const planQ = await prisma.debtCardInstallment.findFirst({ where: { tarjetaId: q.debt.id } })
    await prisma.debtCardInstallment.update({ where: { id: planQ!.id }, data: { createdAt: mesPasado() } })
    const tq = await tarjetaDe(q.debt.id)
    check('Tarjeta quincenal: el avance de $400.000 a 2 meses suma $100.000 por quincena', cerca(tq.cuotaPeriodo, 150000), tq.cuotaPeriodo)
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
