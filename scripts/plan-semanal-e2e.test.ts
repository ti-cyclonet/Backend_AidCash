/**
 * Prueba del plan semanal contra la base LOCAL con un usuario temporal
 * (@local.test) que se borra al final: npx tsx scripts/plan-semanal-e2e.test.ts
 */
import 'dotenv/config'
import assert from 'node:assert/strict'

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Solo local')
  const { prisma } = await import('../src/config/database.js')
  const { planSemanal } = await import('../src/lib/plan-semanal.js')
  const correo = `plan-semanal-${Date.now()}@local.test`
  const u = await prisma.user.create({ data: { correo, username: correo.split('@')[0], passwordHash: 'x', nombre: 'QA Plan', frecuenciaIngreso: 'quincenal', diasPago: [15, 30], cashBalance: 1_000_000 } as never })
  const at = (s: string, h = 12) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, h) }
  const gasto = (monto: number, fecha: string) => prisma.impulseExpense.create({ data: { userId: u.id, nombre: 'Prueba', monto, periodo: 'x', createdAt: at(fecha) } })
  try {
    // Semana 1 = 15–22 nov (8 días), semana 2 = 23–29 nov (7 días)
    let p = await planSemanal(u.id, 300_000, at('2026-11-16'))
    assert.ok(p)
    assert.equal(p!.disponible, 500_000)
    assert.deepEqual(p!.semanas.map(s => s.dias), [8, 7])
    assert.equal(p!.semanas[0].meta, 266_667)
    assert.equal(p!.semanas[1].meta, 233_333)
    assert.equal(p!.semanas[0].estado, 'actual')
    console.log('  ok metas iniciales', p!.semanas.map(s => s.meta))

    await gasto(100_000, '2026-11-17')
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 900_000 } })
    p = await planSemanal(u.id, 300_000, at('2026-11-18'))
    assert.equal(p!.semanas[0].meta, 266_667, 'la meta de la semana en curso no cambia')
    assert.equal(p!.semanas[0].gastado, 100_000)
    assert.equal(p!.semanas[1].meta, 253_333, 'la semana 2 se recalcula con lo que queda')
    console.log('  ok meta congelada y semana 2 recalculada', p!.semanas[1].meta, 'hoy puedes', p!.hoyPuedes)

    p = await planSemanal(u.id, 300_000, at('2026-11-24'))
    assert.equal(p!.semanas[0].estado, 'lograda')
    assert.equal(p!.semanas[0].monedas, 5)
    assert.equal(p!.semanas[1].estado, 'actual')
    assert.equal(p!.semanas[1].meta, 420_000, 'lo no gastado pasa a la semana siguiente')
    await planSemanal(u.id, 300_000, at('2026-11-25'))
    let yo = await prisma.user.findUnique({ where: { id: u.id }, select: { monedas: true, xpFromJardin: true } })
    assert.equal(yo!.monedas, 5, 'las monedas no se pagan dos veces'); assert.equal(yo!.xpFromJardin, 20)
    console.log('  ok semana 1 lograda: +5 monedas y +20 XP, una sola vez')

    await gasto(500_000, '2026-11-25')
    p = await planSemanal(u.id, 0, at('2026-12-01'))
    assert.equal(p!.periodo.inicio, '2026-11-30')
    const s2 = await prisma.semanaPlan.findFirst({ where: { userId: u.id, periodo: '2026-11-15', indice: 2 } })
    assert.equal(s2!.estado, 'fallida'); assert.equal(Number(s2!.gastado), 500_000)
    yo = await prisma.user.findUnique({ where: { id: u.id }, select: { monedas: true } })
    assert.equal(yo!.monedas, 5)
    assert.equal(p!.racha, 0)
    console.log('  ok semana 2 fallida (gastó 500.000 de 420.000), sin monedas; periodo nuevo', p!.periodo, p!.semanas.map(s => `${s.estado}:${s.meta}`))

    // Periodo 15–29 dic sin saldo: meta 0. Llega un ingreso: la meta congelada sube
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 0 } })
    p = await planSemanal(u.id, 0, at('2026-12-16', 9))
    assert.equal(p!.semanas[0].meta, 0)
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 1_500_000 } })
    p = await planSemanal(u.id, 0, at('2026-12-16', 10))
    const conSueldo = p!.semanas[0].meta
    assert.ok(conSueldo > 0, 'con meta 0 se recalcula al llegar plata')
    await prisma.incomeRecord.create({ data: { userId: u.id, monto: 500_000, tipo: 'extra', createdAt: at('2026-12-17', 8) } })
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 2_000_000 } })
    p = await planSemanal(u.id, 0, at('2026-12-17', 9))
    assert.ok(p!.semanas[0].meta > conSueldo, 'un ingreso nuevo sube la meta congelada')
    // Sin ingreso nuevo, gastar no infla la meta
    const conExtra = p!.semanas[0].meta
    await gasto(300_000, '2026-12-17')
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 1_700_000 } })
    p = await planSemanal(u.id, 0, at('2026-12-18', 9))
    assert.equal(p!.semanas[0].meta, conExtra)
    console.log('  ok meta 0 →', conSueldo, '→ con ingreso extra', conExtra, '; gastar no la cambia. Consejos:', p!.consejos.map(c => c.tipo))

    // Obligaciones que se comen el saldo: lo gastado esta semana NO se vuelve meta
    await prisma.semanaPlan.deleteMany({ where: { userId: u.id } })
    await prisma.impulseExpense.deleteMany({ where: { userId: u.id } })
    await gasto(570_100, '2027-01-03')
    await prisma.user.update({ where: { id: u.id }, data: { cashBalance: 129_900 } })
    p = await planSemanal(u.id, 465_000, at('2027-01-04'))
    const s1 = p!.semanas.find(s => s.estado === 'actual')!
    assert.equal(p!.disponible, 0)
    assert.ok(s1.meta < 570_100, `meta ${s1.meta} no puede ser lo gastado`)
    assert.equal(s1.meta, 65_000) // saldo al empezar 700.000 − 465.000 → ahorro 105.000 → libre 130.000 × 8/16 (periodo 30 dic–14 ene)
    console.log('  ok sobrecargado: meta', s1.meta, 'con 570.100 gastados → consejos', p!.consejos.map(c => c.tipo))
  } finally {
    await prisma.user.delete({ where: { id: u.id } })
    await prisma.$disconnect()
  }
  console.log('Plan semanal e2e ok (usuario temporal borrado)')
}
main().catch(e => { console.error(e); process.exit(1) })
