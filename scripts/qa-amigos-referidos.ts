/**
 * QA en navegador: le crea a un usuario temporal amigos invitados que ya usan
 * Kiri (para ver Invita y gana, sus niveles y las flores del árbol).
 *   npx tsx scripts/qa-amigos-referidos.ts <userId> <cantidad>
 *   npx tsx scripts/qa-amigos-referidos.ts borrar <userId>   → borra esos amigos
 * Solo trabaja con cuentas @qa-navegador.test.
 */
import 'dotenv/config'

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const { revisarNiveles } = await import('../src/lib/referidos.js')
  const { syncReferralMissions } = await import('../src/lib/missions.js')
  const [a, b] = process.argv.slice(2)
  if (a === 'borrar') {
    const r = await prisma.user.deleteMany({ where: { invitedById: b, correo: { endsWith: '@qa-navegador.test' } } })
    console.log(JSON.stringify({ amigosBorrados: r.count }))
    await prisma.$disconnect()
    return
  }
  const inviter = await prisma.user.findUnique({ where: { id: a } })
  if (!inviter?.correo.endsWith('@qa-navegador.test')) throw new Error('Solo para usuarios de QA')
  const stamp = Date.now()
  const nombres = ['Camila', 'Andrés', 'Valentina', 'Santiago', 'Mariana', 'Juan']
  for (let i = 0; i < Number(b); i++) {
    await prisma.user.create({ data: {
      nombre: `${nombres[i % nombres.length]} QA`, correo: `amigo${i}-${stamp}@qa-navegador.test`, username: `amigoqa${i}${String(stamp).slice(-7)}`,
      passwordHash: 'x', isActive: true, onboardingDone: true, invitedById: a, referidoActivadoEn: new Date(),
    } })
  }
  await syncReferralMissions(a)
  console.log(JSON.stringify({ niveles: await revisarNiveles(a) }))
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
