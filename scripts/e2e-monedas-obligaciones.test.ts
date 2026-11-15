/**
 * Monedas por obligaciones (2026-11): ya no se gana +5 por cada cuota pagada;
 * se ganan +20 UNA vez por periodo de cobro, cuando ya no queda ninguna
 * obligación pendiente. Si se deshace un pago el mismo día y vuelve a quedar
 * algo pendiente, se quitan, y se recuperan al volver a ponerse al día.
 *
 *   npx tsx scripts/e2e-monedas-obligaciones.test.ts   (usuario temporal @local.test)
 */
import 'dotenv/config'

let fallas = 0
const check = (nombre: string, ok: boolean, info?: unknown) => {
  if (!ok) fallas++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${info !== undefined ? '  → ' + JSON.stringify(info) : ''}`)
}

;(async () => {
  const { prisma } = await import('../src/config/database.js')
  const eco = await import('../src/lib/economia.js')
  const { getPeriodo } = await import('../src/lib/period.js')
  const stamp = Date.now()
  const u = await prisma.user.create({ data: { nombre: 'Oblig Prueba', correo: `oblig-${stamp}@local.test`, username: `oblig${stamp}`, passwordHash: 'x', onboardingDone: true } })
  try {
    const periodo = getPeriodo('mensual')
    const monedas = async () => (await prisma.user.findUnique({ where: { id: u.id }, select: { monedas: true } }))!.monedas
    const arriendo = await prisma.fixedExpense.create({ data: { userId: u.id, nombre: 'Arriendo', monto: 650000, fechaCorte: '5', frecuencia: 'mensual' } })
    const internet = await prisma.fixedExpense.create({ data: { userId: u.id, nombre: 'Internet', monto: 90000, fechaCorte: '10', frecuencia: 'mensual' } })

    const p1 = await prisma.fixedExpensePayment.create({ data: { fixedExpenseId: arriendo.id, montoPagado: 650000, periodo } })
    check('Pagar una sola obligación (queda otra pendiente) no da monedas', (await eco.abonarPago(u.id, p1.id)) === 0 && (await monedas()) === 0)

    const p2 = await prisma.fixedExpensePayment.create({ data: { fixedExpenseId: internet.id, montoPagado: 90000, periodo } })
    const gano = await eco.abonarPago(u.id, p2.id)
    check('Al quedar al día con todo el periodo: +20', gano === 20 && (await monedas()) === 20, { gano })

    check('Otro pago en el mismo periodo no vuelve a dar', (await eco.abonarPago(u.id, p2.id)) === 0 && (await monedas()) === 20)

    const t = await eco.estadoTienda(u.id)
    check('La tienda muestra que ya las ganó este periodo', t.abonos.obligaciones.ganadasEstePeriodo === true && t.abonos.obligaciones.monedas === 20, t.abonos.obligaciones)

    await prisma.fixedExpensePayment.delete({ where: { id: p2.id } })
    const rev = await eco.revertirAbono(u.id, 'pago', p2.id)
    check('Deshacer el pago el mismo día (queda pendiente): se quitan las 20', rev === -20 && (await monedas()) === 0, { rev })

    const p3 = await prisma.fixedExpensePayment.create({ data: { fixedExpenseId: internet.id, montoPagado: 90000, periodo } })
    check('Volver a ponerse al día: recupera las 20', (await eco.abonarPago(u.id, p3.id)) === 20 && (await monedas()) === 20)
  } finally {
    await prisma.user.delete({ where: { id: u.id } })
    await prisma.$disconnect()
  }
  console.log(fallas ? `\n${fallas} FALLAS` : '\nTodo OK — usuario temporal eliminado')
  process.exit(fallas ? 1 : 0)
})()
