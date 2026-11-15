/**
 * Pone a un usuario de QA del navegador (@qa-navegador.test) en un estado de
 * plan para revisar las pantallas: free | prueba (le quedan 2 días) |
 * terminada (terminó hace 3 h) | restaurar (lo deja como estaba).
 *
 *   npx tsx scripts/qa-plan-estado.ts <correo@qa-navegador.test> <estado>
 *
 * Guarda el estado original en scripts/.qa-plan-estado.json para restaurarlo.
 */
import 'dotenv/config'
import fs from 'fs'

;(async () => {
  const [correo, estado] = process.argv.slice(2)
  if (!correo?.endsWith('@qa-navegador.test')) { console.error('Solo usuarios @qa-navegador.test'); process.exit(1) }
  const { prisma } = await import('../src/config/database.js')
  const { invalidarPlan } = await import('../src/lib/planes.js')
  const u = await prisma.user.findUnique({ where: { correo }, select: { id: true, pruebaPlusHasta: true, pruebaProHasta: true } })
  if (!u) { console.error('No existe'); process.exit(1) }
  const archivo = new URL('./.qa-plan-estado.json', import.meta.url)
  const DIA = 86400000
  if (!fs.existsSync(archivo) && estado !== 'restaurar') {
    const premio = await prisma.referidoPremio.findUnique({ where: { userId_clave: { userId: u.id, clave: 'prueba_bienvenida' } } })
    fs.writeFileSync(archivo, JSON.stringify({ pruebaPlusHasta: u.pruebaPlusHasta, pruebaProHasta: u.pruebaProHasta, teniaPremio: !!premio }))
  }
  const quitarPremio = () => prisma.referidoPremio.deleteMany({ where: { userId: u.id, clave: 'prueba_bienvenida' } })
  const ponerPremio = () => prisma.referidoPremio.upsert({ where: { userId_clave: { userId: u.id, clave: 'prueba_bienvenida' } }, create: { userId: u.id, clave: 'prueba_bienvenida', premio: '14 días de KIRI PLUS de bienvenida (QA)' }, update: {} })
  if (estado === 'free') { await quitarPremio(); await prisma.user.update({ where: { id: u.id }, data: { pruebaPlusHasta: null, pruebaProHasta: null } }) }
  else if (estado === 'prueba') { await ponerPremio(); await prisma.user.update({ where: { id: u.id }, data: { pruebaPlusHasta: new Date(Date.now() + 1.5 * DIA), pruebaProHasta: null } }) }
  else if (estado === 'terminada') { await ponerPremio(); await prisma.user.update({ where: { id: u.id }, data: { pruebaPlusHasta: new Date(Date.now() - 3 * 3600000), pruebaProHasta: null } }) }
  else if (estado === 'restaurar') {
    if (!fs.existsSync(archivo)) { console.log('Nada que restaurar'); process.exit(0) }
    const o = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    if (!o.teniaPremio) await quitarPremio()
    await prisma.user.update({ where: { id: u.id }, data: { pruebaPlusHasta: o.pruebaPlusHasta ? new Date(o.pruebaPlusHasta) : null, pruebaProHasta: o.pruebaProHasta ? new Date(o.pruebaProHasta) : null } })
    fs.unlinkSync(archivo)
  } else { console.error('Estado: free | prueba | terminada | restaurar'); process.exit(1) }
  invalidarPlan(u.id)
  console.log('listo:', estado)
  await prisma.$disconnect()
})()
