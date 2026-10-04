/**
 * Categorías de presupuesto: el límite puede ser MENSUAL o QUINCENAL.
 * Caso real: un usuario quincenal ponía Mercado $800.000 al mes, Kiri lo partía
 * a la mitad por quincena y, al hacer el mercado del mes en una quincena, la
 * categoría salía "excedida". Ahora el mensual suma todo el mes de pago sin
 * dividir y el quincenal se reinicia cada quincena. Usuarios temporales que se
 * borran al final.
 *   npx tsx scripts/e2e-categorias.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4186
process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1'

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + JSON.stringify(extra).slice(0, 260) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { getPeriodo } = await import('../src/lib/period.js')
  const app = express()
  app.use(express.json())
  app.use('/api/budget-categories', (await import('../src/routes/budget-categories.routes.js')).default)
  app.use('/api/impulse-expenses', (await import('../src/routes/impulse.routes.js')).default)
  app.use(errorHandler)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const nuevoUsuario = async (nombre: string, frecuencia: 'mensual' | 'quincenal', diasPago: number[]) => {
    const u = await prisma.user.create({ data: { nombre, correo: `${nombre.toLowerCase().replace(/\s/g, '')}-${stamp}@categorias.test`, username: `${nombre.slice(0, 6)}${stamp}`.slice(0, 20), passwordHash: 'x', onboardingDone: true, ingresoBase: 4000000, frecuenciaIngreso: frecuencia, diasPago, cashBalance: 3000000, walletLibre: 3000000 } })
    ids.push(u.id)
    const token = jwt.sign({ userId: u.id, correo: u.correo }, process.env.JWT_SECRET!, { expiresIn: '1h' })
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
      return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
    }
    return { u, call }
  }

  // Un día que cae en la quincena ANTERIOR pero en el mismo mes de pago
  // (frontera real de los días de cobro 15 y 30). Si hoy es la primera quincena
  // del mes de pago, no hay quincena anterior en el mismo mes: se avisa.
  const quincenaDe = (d: Date) => getPeriodo('quincenal', [15, 30], d)
  const hoy = new Date()
  let otraQuincena: Date | null = null
  for (let i = 1; i <= 31; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - i, 12)
    if (quincenaDe(d) !== quincenaDe(hoy)) { if (quincenaDe(d).slice(0, 7) === quincenaDe(hoy).slice(0, 7)) otraQuincena = d; break }
  }
  const gasto = async (call: any, budgetCategoryId: string, nombre: string, monto: number, fecha?: Date) => {
    const r = await call('POST', '/impulse-expenses', { nombre, monto, budgetCategoryId })
    if (fecha && r.expense?.id) await prisma.impulseExpense.update({ where: { id: r.expense.id }, data: { createdAt: fecha } })
    return r
  }
  const resumen = async (call: any, alcance = 'periodo') => (await call('GET', `/budget-categories/resumen?alcance=${alcance}`)).categorias as any[]

  try {
    // ── Usuario quincenal (cobra el 15 y el 30) ──
    const q = await nuevoUsuario('Quina Quincenal', 'quincenal', [15, 30])
    const mercado = await q.call('POST', '/budget-categories', { nombre: 'Mercado', montoLimite: 800000 })
    check('Categoría sin frecuencia → mensual por defecto', mercado.status === 201 && mercado.category?.frecuenciaLimite === 'mensual', mercado.category?.frecuenciaLimite)
    const salidas = await q.call('POST', '/budget-categories', { nombre: 'Salidas', montoLimite: 150000, frecuenciaLimite: 'quincenal' })
    check('Categoría quincenal creada', salidas.status === 201 && salidas.category?.frecuenciaLimite === 'quincenal')
    const mal = await q.call('POST', '/budget-categories', { nombre: 'Rara', montoLimite: 1, frecuenciaLimite: 'semanal' })
    check('Frecuencia inválida → 400', mal.status === 400, mal.status)

    await gasto(q.call, mercado.category.id, 'Mercado del mes', 600000)
    let cats = await resumen(q.call)
    let m = cats.find(c => c.id === mercado.category.id)
    check('Mensual: el límite NO se divide (800.000 completo)', m.limite === 800000 && m.limiteConfigurado === 800000, { limite: m.limite })
    check('Mensual: $600.000 de $800.000 → no excedido (antes salía excedido)', m.gastado === 600000 && m.estado !== 'excedido', { gastado: m.gastado, estado: m.estado })

    if (otraQuincena) {
      await gasto(q.call, mercado.category.id, 'Mercado extra', 150000, otraQuincena)
      await gasto(q.call, salidas.category.id, 'Cine', 50000, otraQuincena)
      cats = await resumen(q.call)
      m = cats.find(c => c.id === mercado.category.id)
      check('Mensual: suma también lo de la otra quincena del mismo mes', m.gastado === 750000, m.gastado)
    } else {
      console.log('INFO  Hoy es la primera quincena del mes de pago: se omite la prueba con la quincena anterior')
    }

    await gasto(q.call, salidas.category.id, 'Bar', 100000)
    cats = await resumen(q.call)
    let s = cats.find(c => c.id === salidas.category.id)
    check('Quincenal: límite tal cual (150.000) y solo cuenta esta quincena', s.limite === 150000 && s.gastado === 100000, { limite: s.limite, gastado: s.gastado })
    check('Quincenal: su rango es más corto que el de la mensual', new Date(s.periodo.fin).getTime() - new Date(s.periodo.inicio).getTime() < new Date(m.periodo.fin).getTime() - new Date(m.periodo.inicio).getTime())

    // Alerta al cruzar el 100% de la mensual (con el mes completo)
    const yaGastado = m.gastado
    const cruce = await gasto(q.call, mercado.category.id, 'Mercado final', 800000 - yaGastado + 10000)
    check('Al pasar los $800.000 del mes avisa "excedido"', cruce.alertaCategoria?.nivel === 'excedido' && cruce.alertaCategoria?.limite === 800000 && cruce.alertaCategoria?.frecuenciaLimite === 'mensual', cruce.alertaCategoria)

    // Editar: quincenal → mensual
    const edit = await q.call('PATCH', `/budget-categories/${salidas.category.id}`, { frecuenciaLimite: 'mensual' })
    check('Editar la frecuencia funciona', edit.status === 200 && edit.category?.frecuenciaLimite === 'mensual', edit.category?.frecuenciaLimite)
    const lista = (await q.call('GET', '/budget-categories')).categories as any[]
    check('La lista devuelve la frecuencia guardada', lista.find(c => c.id === salidas.category.id)?.frecuenciaLimite === 'mensual')
    cats = await resumen(q.call)
    s = cats.find(c => c.id === salidas.category.id)
    check('Salidas ahora mensual: suma todo el mes de pago', s.frecuenciaLimite === 'mensual' && s.gastado === (otraQuincena ? 150000 : 100000), { gastado: s.gastado })
    const editMal = await q.call('PATCH', `/budget-categories/${salidas.category.id}`, { frecuenciaLimite: 'anual' })
    check('Editar con frecuencia inválida → 400', editMal.status === 400, editMal.status)

    // Vista de mes calendario: una quincenal cuenta dos quincenas
    await q.call('PATCH', `/budget-categories/${salidas.category.id}`, { frecuenciaLimite: 'quincenal' })
    const mes = await resumen(q.call, 'mes')
    check('Vista "mes": la quincenal muestra 2 quincenas de límite (300.000)', mes.find(c => c.id === salidas.category.id)?.limite === 300000)

    // ── Usuario mensual con una categoría quincenal (1–15 / 16–fin) ──
    const mm = await nuevoUsuario('Mona Mensual', 'mensual', [30])
    const tr = await mm.call('POST', '/budget-categories', { nombre: 'Transporte', montoLimite: 100000, frecuenciaLimite: 'quincenal' })
    await gasto(mm.call, tr.category.id, 'Uber', 40000)
    const otraMitad = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() <= 15 ? 20 : 5, 12)
    if (otraMitad.getMonth() === hoy.getMonth()) await gasto(mm.call, tr.category.id, 'Taxi', 70000, otraMitad)
    const t = (await resumen(mm.call)).find(c => c.id === tr.category.id)
    check('Usuario mensual + categoría quincenal: solo cuenta su mitad del mes', t.limite === 100000 && t.gastado === 40000, { limite: t.limite, gastado: t.gastado })
  } finally {
    await prisma.impulseExpense.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    server.close()
    await prisma.$disconnect()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} OK`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
