/**
 * Tarjetas y créditos de compras como LÍNEAS DE CRÉDITO con cupo.
 * Caso real: una tarjeta pagada por completo quedaba "saldada" y desaparecía
 * al registrar un gasto con tarjeta. Ahora nunca se termina, tiene cupo
 * (ocupado / disponible), avisa al pasarse (sin bloquear) y detecta los
 * intereses reales con el saldo del banco. Usuario temporal que se borra.
 *   npx tsx scripts/e2e-lineas-credito.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4187
process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra).slice(0, 260) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { isDebtPending } = await import('../src/lib/obligation-schedule.js')
  const app = express()
  app.use(express.json())
  app.use('/api/debts', (await import('../src/routes/debts.routes.js')).default)
  app.use('/api/impulse-expenses', (await import('../src/routes/impulse.routes.js')).default)
  app.use(errorHandler)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const u = await prisma.user.create({ data: { nombre: 'Lina Linea', correo: `lina-${stamp}@lineas.test`, username: `lina${stamp}`.slice(0, 20), passwordHash: 'x', onboardingDone: true, ingresoBase: 6000000, frecuenciaIngreso: 'mensual', diasPago: [30], cashBalance: 9000000, walletObligaciones: 6000000, walletLibre: 3000000 } })
  const token = jwt.sign({ userId: u.id, correo: u.correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const deuda = async (id: string) => ((await call('GET', '/debts')).debts as any[]).find(d => d.id === id)

  try {
    // ── Fase 2: crear con cupo ──
    const nu = await call('POST', '/debts', { nombre: 'Nu', tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 5000000, montoTotal: 1200000, saldoRestante: 1200000, cuotaPeriodo: 350000, diasPago: '28' })
    check('Tarjeta con cupo creada', nu.status === 201 && nu.debt?.esLineaCredito === true, nu.status)
    check('Cupo $5.000.000 · ocupado $1.200.000 · disponible $3.800.000 (24%)', nu.debt?.cupoTotal === 5000000 && nu.debt?.cupoDisponible === 3800000 && nu.debt?.cupoUsoPct === 24, { cupo: nu.debt?.cupoTotal, disp: nu.debt?.cupoDisponible, pct: nu.debt?.cupoUsoPct })

    const libre = await call('POST', '/debts', { nombre: 'Falabella', tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 2000000, montoTotal: 0, cuotaPeriodo: 0 })
    check('Tarjeta sin usar (ocupado y cuota en $0) se puede registrar', libre.status === 201 && libre.debt?.cupoDisponible === 2000000 && libre.debt?.pagadoEstePeriodo === true, { status: libre.status, err: libre.error })
    const addi = await call('POST', '/debts', { nombre: 'Addi', tipoDeuda: 'CREDITO_COMPRAS', cupoTotal: 1500000, montoTotal: 300000, saldoRestante: 300000, cuotaPeriodo: 100000 })
    check('Crédito de compras (Addi) con cupo', addi.status === 201 && addi.debt?.tipoDeuda === 'CREDITO_COMPRAS' && addi.debt?.cupoDisponible === 1200000, addi.status)
    const malPrestamo = await call('POST', '/debts', { nombre: 'Préstamo raro', montoTotal: 0, cuotaPeriodo: 0 })
    check('Un préstamo sigue exigiendo monto y cuota > 0', malPrestamo.status === 400, malPrestamo.status)

    // ── Fase 1: pagar la tarjeta completa NO la saca ──
    const pagoTotal = await call('POST', `/debts/${nu.debt.id}/pay`, { monto: 1200000 })
    check('Pagar la tarjeta completa → sigue activa ("en ceros", no "liquidada")', pagoTotal.status === 200 && pagoTotal.liquidada === false && pagoTotal.enCeros === true && pagoTotal.debt?.estado === 'activa', { liquidada: pagoTotal.liquidada, enCeros: pagoTotal.enCeros, estado: pagoTotal.debt?.estado })
    let t = await deuda(nu.debt.id)
    check('…y sigue saliendo en la lista de deudas con todo el cupo libre', !!t && t.saldoRestante === 0 && t.cupoDisponible === 5000000 && t.pagadoEstePeriodo === true, { saldo: t?.saldoRestante, disp: t?.cupoDisponible })
    const dbNu = await prisma.debt.findUnique({ where: { id: nu.debt.id } })
    const pagos = await prisma.debtPayment.findMany({ where: { debtId: nu.debt.id } })
    check('En $0 no hay recordatorio de pago pendiente', isDebtPending(dbNu!, pagos) === false)

    const compra = await call('POST', '/impulse-expenses', { nombre: 'Mercado', monto: 400000, tarjetaId: nu.debt.id, cuotas: 1 })
    t = await deuda(nu.debt.id)
    check('Se puede comprar con la tarjeta que estaba en $0 (antes 404)', compra.status === 201 && t.saldoRestante === 400000 && t.cupoDisponible === 4600000, { status: compra.status, saldo: t?.saldoRestante })
    check('…sin aviso de cupo (8%)', compra.avisoCupo === null)

    // ── Aviso de cupo: solo avisa, no bloquea ──
    const alta = await call('POST', '/impulse-expenses', { nombre: 'Celular', monto: 3800000, tarjetaId: nu.debt.id, cuotas: 12 })
    check('Compra que deja la tarjeta en 84% → aviso "alto"', alta.status === 201 && alta.avisoCupo?.nivel === 'alto' && alta.avisoCupo?.usoPct === 84, alta.avisoCupo)
    const pasa = await call('POST', '/impulse-expenses', { nombre: 'Viaje', monto: 1000000, tarjetaId: nu.debt.id, cuotas: 6 })
    check('Compra que pasa el cupo → se registra igual, con aviso "excedido"', pasa.status === 201 && pasa.avisoCupo?.nivel === 'excedido' && pasa.avisoCupo?.disponible === -200000, pasa.avisoCupo)

    // ── Préstamos: se siguen liquidando ──
    const prest = await call('POST', '/debts', { nombre: 'Préstamo Juan', montoTotal: 200000, cuotaPeriodo: 200000 })
    const pagoPrest = await call('POST', `/debts/${prest.debt.id}/pay`, { monto: 200000 })
    check('Un préstamo pagado completo sí queda liquidado', pagoPrest.liquidada === true && pagoPrest.debt?.estado === 'saldada', { liquidada: pagoPrest.liquidada })

    // Reclasificar: una deuda saldada que en realidad es tarjeta vuelve a estar activa
    const recl = await call('PATCH', `/debts/${prest.debt.id}`, { tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 800000 })
    check('Reclasificar a tarjeta la reactiva con su cupo', recl.status === 200 && recl.debt?.estado === 'activa' && recl.debt?.cupoDisponible === 800000, { estado: recl.debt?.estado, disp: recl.debt?.cupoDisponible })

    // ── Fase 4: intereses con el saldo del banco ──
    const davi = await call('POST', '/debts', { nombre: 'Davivienda', tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 3000000, montoTotal: 1000000, saldoRestante: 1000000, cuotaPeriodo: 300000 })
    const pagoBanco = await call('POST', `/debts/${davi.debt.id}/pay`, { monto: 300000, saldoReal: 724000 })
    check('Pago con saldo del banco: separa $24.000 de intereses', pagoBanco.amortizacion?.pagoInteres === 24000 && pagoBanco.amortizacion?.abonoCapital === 276000, pagoBanco.amortizacion)
    check('…y aprende la tasa real de la tarjeta (2,4% mensual)', pagoBanco.tasaObservadaMensual === 2.4, pagoBanco.tasaObservadaMensual)
    t = await deuda(davi.debt.id)
    check('La tarjeta muestra el último interés detectado', t.ultimoInteres?.monto === 24000, t.ultimoInteres)

    // Con una compra de este periodo: no genera interés todavía (base sin la compra)
    const bbva = await call('POST', '/debts', { nombre: 'BBVA', tipoDeuda: 'TARJETA_CREDITO', cupoTotal: 3000000, montoTotal: 1000000, saldoRestante: 1000000, cuotaPeriodo: 300000 })
    await call('POST', '/impulse-expenses', { nombre: 'Zapatos', monto: 200000, tarjetaId: bbva.debt.id, cuotas: 1 })
    const pagoB = await call('POST', `/debts/${bbva.debt.id}/pay`, { monto: 300000, saldoReal: 924000 })
    check('Con una compra del mes: interés $24.000 sobre $1.000.000 → 2,4% (no 2%)', pagoB.amortizacion?.pagoInteres === 24000 && pagoB.tasaObservadaMensual === 2.4, { interes: pagoB.amortizacion?.pagoInteres, tasa: pagoB.tasaObservadaMensual })

    // Actualizar saldo sin pagar
    const antes = (await deuda(davi.debt.id)).saldoRestante
    const aj = await call('POST', `/debts/${davi.debt.id}/ajustar-saldo`, { saldoBanco: antes + 18000 })
    check('Actualizar saldo (+$18.000) → intereses y cargos', aj.status === 200 && aj.ajuste?.tipo === 'interes' && aj.ajuste?.monto === 18000 && aj.debt?.saldoRestante === antes + 18000, aj.ajuste)
    const aj2 = await call('POST', `/debts/${davi.debt.id}/ajustar-saldo`, { saldoBanco: antes + 18000 + 150000, motivo: 'compras' })
    const gastoCompras = await prisma.impulseExpense.findFirst({ where: { userId: u.id, tarjetaId: davi.debt.id, nombre: { startsWith: 'Compras sin registrar' } } })
    check('Actualizar saldo como "compras" → crea el gasto y sube el saldo', aj2.ajuste?.tipo === 'compras' && !!gastoCompras && Number(gastoCompras.monto) === 150000, aj2.ajuste)
    const cashAntes = Number((await prisma.user.findUnique({ where: { id: u.id } }))!.cashBalance)
    await call('DELETE', `/impulse-expenses/${gastoCompras!.id}`)
    t = await deuda(davi.debt.id)
    const cashDespues = Number((await prisma.user.findUnique({ where: { id: u.id } }))!.cashBalance)
    check('Borrar ese gasto le quita la plata a la tarjeta (no a la billetera)', t.saldoRestante === antes + 18000 && cashAntes === cashDespues, { saldo: t.saldoRestante, cashAntes, cashDespues })
    const aj3 = await call('POST', `/debts/${davi.debt.id}/ajustar-saldo`, { saldoBanco: 500000 })
    check('Si el banco dice menos → corrección', aj3.ajuste?.tipo === 'correccion' && aj3.debt?.saldoRestante === 500000, aj3.ajuste)
    const malAj = await call('POST', `/debts/${prest.debt.id}/ajustar-saldo`, { saldoBanco: 999999, motivo: 'compras' })
    const loan2 = await call('POST', '/debts', { nombre: 'Moto', montoTotal: 3000000, cuotaPeriodo: 300000 })
    const malAj2 = await call('POST', `/debts/${loan2.debt.id}/ajustar-saldo`, { saldoBanco: 3100000, motivo: 'compras' })
    check('Un préstamo no puede tener "compras sin registrar"', malAj.status === 200 && malAj2.status === 400, { reclasificada: malAj.status, prestamo: malAj2.status })

    // Pagar una obligación con la tarjeta: no la salda y avisa de cupo
    const pwc = await call('POST', '/debts/pay-with-card', { tarjetaId: libre.debt.id, monto: 1700000, cuotas: 3, sourceType: 'debt', sourceId: loan2.debt.id })
    check('Pagar con tarjeta devuelve la tarjeta con cupo y aviso (85%)', pwc.status === 200 && pwc.tarjeta?.cupoDisponible === 300000 && pwc.avisoCupo?.nivel === 'alto', { status: pwc.status, disp: pwc.tarjeta?.cupoDisponible, aviso: pwc.avisoCupo?.nivel })
  } finally {
    await prisma.impulseExpense.deleteMany({ where: { userId: u.id } })
    await prisma.user.delete({ where: { id: u.id } })
    server.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} OK`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
