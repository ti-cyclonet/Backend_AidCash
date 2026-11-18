/**
 * Embudo de los planes: qué ofertas se ven, cuáles se tocan, en qué límites
 * choca la gente y de dónde salen los cambios de plan.
 *
 *   npx tsx scripts/metricas-planes.ts [días=30]
 *
 * Solo lee (no cambia nada). Ignora las cuentas de prueba (@local.test, @qa-navegador.test).
 */
import 'dotenv/config'

;(async () => {
  const { prisma } = await import('../src/config/database.js')
  const dias = Number(process.argv[2] ?? 30)
  const desde = new Date(Date.now() - dias * 86400000)
  const real = { user: { NOT: [{ correo: { endsWith: '@local.test' } }, { correo: { endsWith: '@qa-navegador.test' } }] } }
  const contar = async (tipo: string) => prisma.planEvento.groupBy({ by: ['origen'], where: { tipo, createdAt: { gte: desde }, ...real }, _count: { _all: true }, orderBy: { _count: { origen: 'desc' } } })

  const [nuevos, activados, conPrueba, vistas, clicks, limites, cambios] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: desde }, NOT: real.user.NOT } }),
    prisma.user.count({ where: { createdAt: { gte: desde }, isActive: true, NOT: real.user.NOT } }),
    prisma.planEvento.count({ where: { tipo: 'prueba_inicio', createdAt: { gte: desde }, ...real } }),
    contar('oferta_vista'), contar('oferta_click'), contar('limite'), contar('cambio_plan'),
  ])
  const n = (l: { _count: { _all: number } }[]) => l.reduce((a, x) => a + x._count._all, 0)
  const pct = (a: number, b: number) => (b ? `${Math.round(a / b * 1000) / 10}%` : '—')

  console.log(`\nKiri · embudo de planes (últimos ${dias} días)\n`)
  console.log(`Cuentas nuevas: ${nuevos} · activas: ${activados} (${pct(activados, nuevos)}) · empezaron la prueba de PLUS: ${conPrueba}`)
  console.log(`Ofertas vistas: ${n(vistas)} · tocadas: ${n(clicks)} (${pct(n(clicks), n(vistas))}) · cambios de plan pedidos: ${n(cambios)}\n`)
  const tabla = (titulo: string, l: { origen: string; _count: { _all: number } }[]) => {
    console.log(titulo)
    if (!l.length) console.log('  (nada todavía)')
    for (const x of l) {
      const clic = clicks.find(c => c.origen === x.origen)?._count._all ?? 0
      console.log(`  ${x.origen.padEnd(28)} ${String(x._count._all).padStart(6)}${titulo.startsWith('Ofertas') ? `   tocadas ${clic} (${pct(clic, x._count._all)})` : ''}`)
    }
    console.log('')
  }
  tabla('Ofertas vistas por momento', vistas)
  tabla('Límites alcanzados', limites)
  tabla('Cambios de plan por origen', cambios)
  await prisma.$disconnect()
})()
