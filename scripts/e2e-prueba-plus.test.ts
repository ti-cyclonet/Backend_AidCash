/**
 * Prueba de KIRI PLUS de bienvenida (2026-11): toda cuenta nueva no invitada
 * prueba PLUS 14 días al entrar, una sola vez; las cuentas viejas y las
 * invitadas no (los invitados tienen su prueba de 30 días).
 *
 *   npx tsx scripts/e2e-prueba-plus.test.ts   (usuarios temporales @local.test)
 */
import 'dotenv/config'

let fallas = 0
const check = (nombre: string, ok: boolean, info?: unknown) => {
  if (!ok) fallas++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${nombre}${info !== undefined ? '  → ' + JSON.stringify(info) : ''}`)
}

;(async () => {
  const { prisma } = await import('../src/config/database.js')
  const pp = await import('../src/lib/prueba-plus.js')
  const { resolverPlan, invalidarPlan } = await import('../src/lib/planes.js')
  const { PRUEBA_INVITADO_DIAS } = await import('../src/lib/referidos.js')
  const stamp = Date.now()
  const crear = (sufijo: string, extra: Record<string, unknown> = {}) => prisma.user.create({ data: { nombre: 'Prueba ' + sufijo, correo: `prueba-${sufijo}-${stamp}@local.test`, username: `pr${sufijo}${stamp}`, passwordHash: 'x', onboardingDone: true, isActive: true, ...extra } })
  const nuevo = await crear('nuevo')
  const viejo = await crear('viejo', { createdAt: new Date('2026-10-01T12:00:00Z') })
  const invitado = await crear('inv', { invitedById: viejo.id })
  try {
    check('Los invitados ahora prueban 30 días', PRUEBA_INVITADO_DIAS === 30)

    const dio = await pp.darPruebaBienvenida(nuevo.id)
    invalidarPlan(nuevo.id)
    const plan = await resolverPlan(nuevo.id)
    const u = await prisma.user.findUnique({ where: { id: nuevo.id }, select: { pruebaPlusHasta: true } })
    const dias = u?.pruebaPlusHasta ? Math.round((u.pruebaPlusHasta.getTime() - Date.now()) / 86400000) : 0
    check('Cuenta nueva: recibe 14 días de PLUS', dio && plan.tier === 'PLUS' && dias === 14, { dio, tier: plan.tier, dias })
    check('No se repite al volver a entrar', (await pp.darPruebaBienvenida(nuevo.id)) === false)

    // Exclusivos del jardín: con PLUS (prueba) tiene Aurora pero no Diamante (PRO)
    const eco = await import('../src/lib/economia.js')
    const t1 = await eco.estadoTienda(nuevo.id)
    const aurora = t1.catalogo.color.find((c: { clave: string }) => c.clave === 'aurora') as { tiene: boolean; exclusivo: string | null; incluido: boolean }
    const diamante = t1.catalogo.color.find((c: { clave: string }) => c.clave === 'diamante') as { tiene: boolean; exclusivo: string | null }
    check('Con PLUS tiene el color Aurora y no Diamante (PRO)', aurora?.tiene && aurora.exclusivo === 'PLUS' && !aurora.incluido && !diamante?.tiene && diamante?.exclusivo === 'PRO', { aurora, diamante })
    const eq = await eco.equipar(nuevo.id, 'color', 'aurora')
    check('Se pone Aurora', eq.color === 'aurora')
    let bloqueado = false; try { await eco.equipar(nuevo.id, 'color', 'diamante') } catch { bloqueado = true }
    check('Diamante (PRO) no se puede poner con PLUS', bloqueado)

    const est = await pp.estadoPruebaBienvenida(nuevo.id, plan.tier, plan.fuente)
    check('Mi plan ve la prueba activa con sus días', !!est && est.activa && est.diasRestantes === 14 && !est.recienTerminada, est)

    check('Cuenta vieja: no recibe la prueba', (await pp.darPruebaBienvenida(viejo.id)) === false)
    check('Cuenta invitada: no pasa por la de bienvenida', (await pp.darPruebaBienvenida(invitado.id)) === false)

    // Faltan ~1,5 días → aviso "te quedan 2 días"
    await prisma.user.update({ where: { id: nuevo.id }, data: { pruebaPlusHasta: new Date(Date.now() + 1.5 * 86400000) } })
    check('Aviso de "te quedan 2 días"', (await pp.avisarFinDePrueba(new Date(), [nuevo.id])) === 1)

    // Terminó hace unas horas → aviso de fin y Mi plan la muestra como recién terminada
    await prisma.user.update({ where: { id: nuevo.id }, data: { pruebaPlusHasta: new Date(Date.now() - 3 * 3600000) } })
    invalidarPlan(nuevo.id)
    const plan2 = await resolverPlan(nuevo.id)
    check('Aviso de fin de prueba', (await pp.avisarFinDePrueba(new Date(), [nuevo.id])) === 1)
    const est2 = await pp.estadoPruebaBienvenida(nuevo.id, plan2.tier, plan2.fuente)
    check('Al terminar vuelve a FREE y Mi plan la muestra como recién terminada', plan2.tier === 'FREE' && !!est2?.recienTerminada, { tier: plan2.tier, est2 })
    const t2 = await eco.estadoTienda(nuevo.id)
    check('Sin PLUS el árbol vuelve a su color de siempre (Aurora queda bloqueado)', t2.equipado.color === 'auto' && !(t2.catalogo.color.find((c: { clave: string }) => c.clave === 'aurora') as { tiene: boolean }).tiene, t2.equipado.color)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: [invitado.id, nuevo.id, viejo.id] } } })
    await prisma.$disconnect()
  }
  console.log(fallas ? `\n${fallas} FALLAS` : '\nTodo OK — usuarios temporales eliminados')
  process.exit(fallas ? 1 : 0)
})()
