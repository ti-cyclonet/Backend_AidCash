/**
 * Pone accesorios al usuario de QA del navegador (@qa-navegador.test) sin comprarlos,
 * para revisar los modelos 3D: npx tsx scripts/qa-equipar.ts <userId> cerca=reja frutos=billete ...
 */
import 'dotenv/config'
async function main() {
  const [userId, ...pares] = process.argv.slice(2)
  const { prisma } = await import('../src/config/database.js')
  const u = await prisma.user.findFirst({ where: { id: userId, correo: { endsWith: '@qa-navegador.test' } }, select: { jardinEquipado: true } })
  if (!u) throw new Error('Solo usuarios @qa-navegador.test')
  const eq = { ...((u.jardinEquipado ?? {}) as Record<string, unknown>) }
  for (const p of pares) { const [k, v] = p.split('='); eq[k] = k === 'habitantes' ? v.split(',') : v }
  await prisma.user.update({ where: { id: userId }, data: { jardinEquipado: eq as never } })
  console.log(JSON.stringify(eq))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e.message); process.exit(1) })
