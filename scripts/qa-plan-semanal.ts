/**
 * Prepara al usuario de QA del navegador (@qa-navegador.test) para revisar el
 * plan semanal: npx tsx scripts/qa-plan-semanal.ts <userId> <mensual|quincenal> <saldo> [lograda|fallida]
 * Borra sus semanas y deja la semana 1 del periodo actual cerrada (si ya pasó).
 */
import 'dotenv/config'

async function main() {
  const [userId, frecuencia = 'mensual', saldo = '3200000', estado1 = 'lograda'] = process.argv.slice(2)
  const { prisma } = await import('../src/config/database.js')
  const { rangoDeCobro, partirEnSemanas } = await import('../src/lib/plan-semanal.js')
  const u = await prisma.user.findFirst({ where: { id: userId, correo: { endsWith: '@qa-navegador.test' } } })
  if (!u) throw new Error('Solo usuarios @qa-navegador.test')
  const diasPago = frecuencia === 'quincenal' ? [15, 30] : [1]
  await prisma.user.update({ where: { id: u.id }, data: { frecuenciaIngreso: frecuencia, diasPago, cashBalance: Number(saldo) } })
  await prisma.semanaPlan.deleteMany({ where: { userId: u.id } })
  const { inicio, fin } = rangoDeCobro(frecuencia as 'mensual' | 'quincenal', diasPago)
  const semanas = partirEnSemanas(inicio, fin, frecuencia === 'quincenal' ? 2 : 4)
  const s1 = semanas[0]
  const periodo = `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}-${String(inicio.getDate()).padStart(2, '0')}`
  if (s1.fin <= new Date()) {
    const lograda = estado1 === 'lograda'
    await prisma.semanaPlan.create({ data: {
      userId: u.id, periodo, indice: 1, inicio: s1.inicio, fin: s1.fin, meta: 450000, gastado: lograda ? 380000 : 512000,
      estado: estado1, monedas: lograda ? 5 : 0, congelada: true, congeladaAt: s1.inicio, cerradaAt: s1.fin,
    } })
  }
  console.log(JSON.stringify({ frecuencia, periodo, semanas: semanas.map(s => [s.inicio.toDateString(), s.dias]) }))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e.message); process.exit(1) })
