/**
 * Crea (o borra) un usuario temporal con datos realistas para revisar la app
 * en el navegador sin tocar cuentas reales. Siembra por la API normal (:4000).
 *   npx tsx scripts/qa-usuario-navegador.ts crear   → imprime tokens para localStorage
 *   npx tsx scripts/qa-usuario-navegador.ts crear pro → igual, con KIRI PRO (todo desbloqueado)
 *   npx tsx scripts/qa-usuario-navegador.ts nuevo   → recién registrado, con el test inicial por hacer
 *   npx tsx scripts/qa-usuario-navegador.ts borrar <userId>
 */
import 'dotenv/config'
import crypto from 'node:crypto'

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const { consentLocalData } = await import('../src/lib/legal.js')
  const jwt = (await import('jsonwebtoken')).default
  const [accion, idBorrar] = process.argv.slice(2)
  if (accion === 'borrar') {
    const r = await prisma.user.deleteMany({ where: { id: idBorrar, correo: { endsWith: '@qa-navegador.test' } } })
    console.log(JSON.stringify({ borrados: r.count }))
    await prisma.$disconnect()
    return
  }

  const stamp = Date.now()
  // "nuevo": recién registrado, sin datos y con el test inicial por hacer
  if (accion === 'nuevo') {
    const correo = `nuevo-${stamp}@qa-navegador.test`
    const u = await prisma.user.create({ data: { nombre: 'Nico Nuevo', primerNombre: 'Nico', correo, username: `nuevo${String(stamp).slice(-8)}`, passwordHash: 'x', onboardingDone: false, isActive: true, ...consentLocalData() } })
    const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '12h' })
    const refresh = crypto.randomBytes(40).toString('hex')
    await prisma.refreshToken.create({ data: { userId: u.id, token: refresh, expiresAt: new Date(Date.now() + 86400000) } })
    console.log(JSON.stringify({ userId: u.id, correo, token, refresh }))
    await prisma.$disconnect()
    return
  }
  const correo = `laura-${stamp}@qa-navegador.test`
  const u = await prisma.user.create({ data: {
    nombre: 'Laura Sofía Gómez Restrepo', primerNombre: 'Laura', segundoNombre: 'Sofía', primerApellido: 'Gómez', segundoApellido: 'Restrepo',
    correo, username: `laura${String(stamp).slice(-8)}`, passwordHash: 'x', onboardingDone: true, isActive: true,
    ingresoBase: 3800000, frecuenciaIngreso: 'quincenal', tipoIngreso: 'fijo', diasPago: [15, 30],
    cashBalance: 2150000, walletLibre: 2150000, pruebaPlusHasta: new Date(Date.now() + 10 * 86400000),
    // "crear pro": todo desbloqueado (KIRI PRO prestado 30 días) para ver la app completa en local
    ...(process.argv.includes('pro') ? { pruebaProHasta: new Date(Date.now() + 30 * 86400000) } : {}),
    guiasVistas: ['dashboard', 'gestion', 'obligaciones', 'ahorro', 'balance', 'social', 'misiones', 'jardin'],
    // Ya aceptó los Términos vigentes (si no, la app pide aceptarlos antes de seguir)
    ...consentLocalData(),
  } })
  const token = jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '12h' })
  const refresh = crypto.randomBytes(40).toString('hex')
  await prisma.refreshToken.create({ data: { userId: u.id, token: refresh, expiresAt: new Date(Date.now() + 86400000) } })

  const api = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(`http://localhost:4000/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined })
    const j = await r.json().catch(() => ({})) as Record<string, any>
    if (r.status >= 400) console.error('SEMBRAR', m, p, r.status, JSON.stringify(j).slice(0, 200))
    return j
  }
  const id = (x: Record<string, any>) => x.category?.id ?? x.debt?.id ?? x.fixedExpense?.id ?? x.pocket?.id ?? x.loan?.id ?? x.id

  const cats: Record<string, string> = {}
  for (const [nombre, montoLimite, icono, color] of [['Mercado', 650000, 'shopping-cart', '#10B981'], ['Transporte', 280000, 'car', '#6366F1'], ['Restaurantes y domicilios de fin de semana con amigos', 300000, 'utensils', '#F59E0B'], ['Salud', 150000, 'heart', '#EF4444'], ['Mascotas', 120000, 'dog', '#8B5CF6']] as const) {
    cats[nombre] = id(await api('POST', '/budget-categories', { nombre, montoLimite, icono, color }))
  }
  const tarjeta = id(await api('POST', '/debts', { nombre: 'Tarjeta Visa Bancolombia', montoTotal: 4800000, saldoRestante: 3200000, cuotaPeriodo: 420000, diasPago: '5', tasaInteres: 2.1, tipoDeuda: 'TARJETA_CREDITO', prioridad: 'alta', yaPagoEstePeriodo: true }))
  await api('POST', '/debts', { nombre: 'Crédito de libre inversión Banco de Bogotá para remodelar la cocina y el baño', montoTotal: 4999999999, saldoRestante: 4800000000, cuotaPeriodo: 98765432, diasPago: '20', tasaInteres: 1.3, prioridad: 'media', nuevaProximoPeriodo: true })
  await api('POST', '/debts', { nombre: 'Moto', montoTotal: 6500000, saldoRestante: 2300000, cuotaPeriodo: 350000, frecuenciaPago: 'quincenal', diasPago: '15,30', tasaInteres: 1.8 })
  await api('POST', '/fixed-expenses', { nombre: 'Arriendo', monto: 1200000, fechaCorte: '5', categoria: 'vivienda', yaPagoEstePeriodo: true })
  await api('POST', '/fixed-expenses', { nombre: 'Internet + TV', monto: 115000, fechaCorte: '12', categoria: 'internet', tarjetaVinculadaId: tarjeta })
  await api('POST', '/fixed-expenses', { nombre: 'Netflix', monto: 38900, fechaCorte: '28', categoria: 'suscripciones' })
  await api('POST', '/fixed-expenses', { nombre: 'Servicios públicos (agua, luz y gas) del apartamento', monto: 245000, fechaCorte: '18', categoria: 'servicios', budgetCategoryId: cats['Salud'] })
  for (const [nombre, monto, cat] of [['Almuerzo corrientazo', 18000, 'Restaurantes y domicilios de fin de semana con amigos'], ['Tinto y pandebono', 6500, null], ['Uber al trabajo', 23400, 'Transporte'], ['Mercado D1', 187500, 'Mercado'], ['Concentrado para Luna', 96000, 'Mascotas'], ['Rappi pizza', 64900, 'Restaurantes y domicilios de fin de semana con amigos'], ['Droguería', 42300, 'Salud'], ['<b>Gasto</b> con "comillas" y emoji 🐜☕', 3500, null], ['Gasolina', 90000, 'Transporte'], ['Cine', 38000, null]] as const) {
    await api('POST', '/impulse-expenses', { nombre, monto, descontarBilletera: true, ...(cat ? { budgetCategoryId: cats[cat] } : {}) })
  }
  const viaje = id(await api('POST', '/savings-pockets', { nombre: 'Viaje a Cartagena', meta: 2500000, tipoMeta: 'fecha', fechaLimite: '2026-12-15', color: '#0EA5E9', icono: 'plane' }))
  await api('POST', `/savings-pockets/${viaje}/deposit`, { monto: 900000 })
  await api('POST', '/savings-pockets', { nombre: 'Colchón', meta: 0, color: '#10B981' })
  await api('POST', '/emergency-fund/transaction', { monto: 300000, tipo: 'aporte' })
  await api('POST', '/external-loans', { persona: 'Juan Pérez', telefono: '3001234567', monto: 250000, fechaCompromiso: '2026-10-20', nota: 'Para el taller del carro', salioDeBilletera: true })
  await api('POST', '/external-loans', { persona: 'Tía Marta', monto: 80000, salioDeBilletera: false })
  await api('POST', '/extra-incomes', { nombre: 'Freelance diseño', monto: 450000, temporalidad: 'una_vez' })

  console.log(JSON.stringify({ userId: u.id, correo, token, refresh }))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
