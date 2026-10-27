/**
 * Economía del árbol 3D (lib/economia.ts): monedas, tienda, habitantes, oferta del
 * día y cofres. Usa un usuario temporal y lo borra al terminar.
 *   npx tsx scripts/e2e-economia.test.ts
 */
import 'dotenv/config'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const eco = await import('../src/lib/economia.js')
  const stamp = Date.now()
  const u = await prisma.user.create({ data: { nombre: 'Eco Prueba', correo: `eco-${stamp}@local.test`, username: `eco${stamp}`, passwordHash: 'x', onboardingDone: true } })
  const id = u.id
  const err = async (fn: () => Promise<unknown>) => { try { await fn(); return null } catch (e) { return e instanceof eco.EconomiaError ? e.status : -1 } }
  try {
    // ── Estado inicial ──
    let t = await eco.estadoTienda(id)
    check('Arranca con 0 monedas y el chanchito en la isla', t.monedas === 0 && t.equipado.habitantes.join() === 'chanchito', t.equipado)
    check('Catálogo con 3 habitantes; el chanchito viene incluido', t.catalogo.habitante?.length === 3 && t.catalogo.habitante.find(a => a.clave === 'chanchito')?.incluido === true)
    check('Hay oferta del día con 30 % de descuento sobre algo que no tiene', !!t.oferta && t.oferta.precio < t.oferta.precioNormal && t.oferta.precio > 0, t.oferta)
    const t2 = await eco.estadoTienda(id)
    check('La oferta es la misma todo el día', t2.oferta?.clave === t.oferta?.clave && t2.oferta?.tipo === t.oferta?.tipo)

    // ── Abonos con tope y reverso ──
    for (const r of ['a1', 'a2', 'a3', 'a4']) await eco.abonarAhorro(id, r)
    t = await eco.estadoTienda(id)
    check('Ahorrar: +15 hasta 3 veces al día (4 ahorros → 45)', t.monedas === 45, t.monedas)
    await eco.revertirAbono(id, 'ahorro', 'a2')
    t = await eco.estadoTienda(id)
    check('Borrar un ahorro del día devuelve sus 15 monedas', t.monedas === 30, t.monedas)
    await eco.premiarDeudaSaldada(id, 'deuda-1'); await eco.premiarDeudaSaldada(id, 'deuda-1')
    t = await eco.estadoTienda(id)
    check('Saldar una deuda: +30 y un cofre común, una sola vez', t.monedas === 60 && t.cofres.filter(c => c.tipo === 'comun').length === 1, { monedas: t.monedas, cofres: t.cofres.length })

    // ── Compras y habitantes ──
    check('Comprar sin saldo → 402', await err(() => eco.comprar(id, 'habitante', 'pajaros')) === 402)
    check('Poner un habitante que no tiene → 403', await err(() => eco.equipar(id, 'habitante', 'pajaros')) === 403)
    await prisma.user.update({ where: { id }, data: { monedas: 3000 } })
    t = await eco.estadoTienda(id)
    const precioGnomo = t.oferta?.tipo === 'habitante' && t.oferta.clave === 'gnomo' ? t.oferta.precio : 450
    const ofertaAntes = t.oferta
    await eco.comprar(id, 'habitante', 'gnomo')
    t = await eco.estadoTienda(id)
    if (!(ofertaAntes?.tipo === 'habitante' && ofertaAntes.clave === 'gnomo')) check('Comprar otra cosa no cambia la oferta del día', t.oferta?.clave === ofertaAntes?.clave && t.oferta?.tipo === ofertaAntes?.tipo, { antes: ofertaAntes, ahora: t.oferta })
    check('Comprar un habitante lo deja en la isla y cobra su precio', t.equipado.habitantes.includes('gnomo') && t.monedas === 3000 - precioGnomo, { hab: t.equipado.habitantes, monedas: t.monedas })
    check('Comprar lo mismo dos veces → 409', await err(() => eco.comprar(id, 'habitante', 'gnomo')) === 409)
    let eq = await eco.equipar(id, 'habitante', 'gnomo')
    check('Tocar "quitar" saca al habitante de la isla (sigue siendo suyo)', !eq.habitantes.includes('gnomo') && eq.habitantes.includes('chanchito'))
    eq = await eco.equipar(id, 'habitante', 'gnomo')
    check('…y "ponerlo" lo vuelve a poner', eq.habitantes.includes('gnomo'))
    eq = await eco.equipar(id, 'especie', 'kiri')
    check('Equipar una especie no toca los habitantes', eq.especie === 'kiri' && eq.habitantes.includes('gnomo'))

    // ── Oferta del día: se cobra con descuento ──
    t = await eco.estadoTienda(id)
    if (t.oferta) {
      const antes = t.monedas, o = t.oferta
      await eco.comprar(id, o.tipo, o.clave)
      t = await eco.estadoTienda(id)
      check('La oferta del día se cobra con su descuento', t.monedas === antes - o.precio, { antes, despues: t.monedas, precio: o.precio })
    } else check('La oferta del día se cobra con su descuento', true, 'sin oferta (lo tiene todo)')

    // ── Cofres ──
    const comun = t.cofres.find(c => c.tipo === 'comun')!
    const antesCofre = t.monedas
    const pc = await eco.abrirCofre(id, comun.id)
    t = await eco.estadoTienda(id)
    check('Cofre común: 10–40 monedas y nunca un aspecto', pc.monedas >= 10 && pc.monedas <= 40 && (!pc.articulo || pc.articulo.tipo === 'color') && t.monedas === antesCofre + pc.monedas, pc)
    check('Un cofre no se abre dos veces → 409', await err(() => eco.abrirCofre(id, comun.id)) === 409)
    const leg = await eco.comprarCofreLegendario(id)
    const pl = await eco.abrirCofre(id, leg.id)
    check('Cofre legendario: siempre trae un aspecto o habitante que no tenía', !!pl.articulo && pl.articulo.tipo !== 'color', pl)

    // ── Datos raros en lo equipado ──
    await prisma.user.update({ where: { id }, data: { jardinEquipado: { especie: 'inventada', habitantes: ['gato-falso', 'gnomo', 7] } } })
    t = await eco.estadoTienda(id)
    check('Lo equipado inválido vuelve a lo seguro (especie por defecto, solo habitantes que existen)', t.equipado.especie === 'kiri' && t.equipado.habitantes.join() === 'gnomo', t.equipado)

    // ── Monedas del plan ──
    check('Sin plan pago no hay regalo mensual', t.plan.monedasMes === 0 && t.plan.regaloRecibido === 0, t.plan)
  } catch (e) {
    console.error('ERROR', e)
    results.push(false)
  } finally {
    await prisma.user.delete({ where: { id } }).catch(() => {})
    await prisma.$disconnect()
    console.log(`\n${results.filter(Boolean).length}/${results.length} OK — usuario temporal eliminado`)
    process.exit(0)
  }
}
main()
