/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Seed: Usuario de Prueba Avanzado — Kiri Finance
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Crea un usuario que simula llevar ~4 meses usando la app activamente:
 *   - Nivel 4 de gamificación (streak alto, varias insignias)
 *   - Deudas activas con historial de pagos
 *   - Gastos fijos variados
 *   - Bolsillos de ahorro personales
 *   - Categorías de presupuesto
 *   - Gastos hormiga de las últimas semanas (para proyecciones de IA)
 *   - Wallet con distribución real
 *   - Fondo de emergencia
 *   - Ingresos extra
 *
 * Ejecutar: npx tsx prisma/seed-test-user.ts
 * Login: test@kiri.app / Test1234!
 */

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Creando usuario de prueba avanzado...\n')

  const passwordHash = await bcrypt.hash('Test1234!', 12)

  // ─── Usuario principal ──────────────────────────────────────────────────────
  const user = await prisma.user.upsert({
    where: { correo: 'test@kiri.app' },
    update: {
      nombre: 'Carlos Mendoza',
      ingresoBase: 4200000,
      frecuenciaIngreso: 'quincenal',
      diasPago: [15, 30],
      onboardingDone: true,
      metaAhorroGlobal: 15000000,
      saldoAhorroTotal: 3850000,
      fondoEmergenciaActual: 2100000,
      streakActual: 12,
      streakMejor: 18,
      cashBalance: 4200000,
      walletAhorro: 630000,
      walletObligaciones: 2100000,
      walletLibre: 1050000,
      walletEndeudamiento: 420000,
    },
    create: {
      nombre: 'Carlos Mendoza',
      correo: 'test@kiri.app',
      passwordHash,
      ingresoBase: 4200000,
      frecuenciaIngreso: 'quincenal',
      diasPago: [15, 30],
      onboardingDone: true,
      metaAhorroGlobal: 15000000,
      saldoAhorroTotal: 3850000,
      fondoEmergenciaActual: 2100000,
      streakActual: 12,
      streakMejor: 18,
      cashBalance: 4200000,
      walletAhorro: 630000,
      walletObligaciones: 2100000,
      walletLibre: 1050000,
      walletEndeudamiento: 420000,
    },
  })

  console.log(`  ✅ Usuario: ${user.correo} (${user.nombre})`)
  console.log(`     ID: ${user.id}`)

  // Limpiar datos anteriores del usuario (para re-ejecución limpia)
  await prisma.debt.deleteMany({ where: { userId: user.id } })
  await prisma.fixedExpense.deleteMany({ where: { userId: user.id } })
  await prisma.impulseExpense.deleteMany({ where: { userId: user.id } })
  await prisma.savingsHistory.deleteMany({ where: { userId: user.id } })
  await prisma.extraIncome.deleteMany({ where: { userId: user.id } })
  await prisma.emergencyFundHistory.deleteMany({ where: { userId: user.id } })
  await prisma.userBadge.deleteMany({ where: { userId: user.id } })
  await prisma.incomeRecord.deleteMany({ where: { userId: user.id } })
  await prisma.savingsPocket.deleteMany({ where: { userId: user.id } })
  await prisma.budgetCategory.deleteMany({ where: { userId: user.id } })

  // ─── Bancos ─────────────────────────────────────────────────────────────────
  const bancolombia = await prisma.bankEntity.upsert({
    where: { nombre: 'Bancolombia' },
    update: {},
    create: { nombre: 'Bancolombia', tasaInteresPromedio: 2.05, esVerificado: true },
  })
  const davivienda = await prisma.bankEntity.upsert({
    where: { nombre: 'Davivienda' },
    update: {},
    create: { nombre: 'Davivienda', tasaInteresPromedio: 2.15, esVerificado: true },
  })
  const nubank = await prisma.bankEntity.upsert({
    where: { nombre: 'Nu Colombia' },
    update: {},
    create: { nombre: 'Nu Colombia', tasaInteresPromedio: 1.89, esVerificado: true },
  })

  console.log('  ✅ Bancos creados/verificados')

  // ─── Deudas (con tasas de interés reales colombianas) ───────────────────────
  await prisma.debt.createMany({
    data: [
      {
        userId: user.id,
        nombre: 'Tarjeta Visa Bancolombia',
        tipoDeuda: 'TARJETA_CREDITO',
        montoTotal: 8500000,
        montoInicial: 8500000,
        saldoRestante: 5200000,
        saldoPrincipal: 4800000,
        cuotaPeriodo: 680000,
        tasaInteres: 26.5,
        tasaInteresAplicada: 2.05,
        tasaInteresMensual: 1.97,
        diaCorte: 5,
        acreedor: 'Bancolombia',
        frecuenciaPago: 'mensual',
        diasPago: '25',
        pagadoEstePeriodo: false,
        estado: 'activa',
        prioridad: 'alta',
        bankEntityId: bancolombia.id,
        pagoAutomatico: false,
      },
      {
        userId: user.id,
        nombre: 'Crédito libre inversión Davivienda',
        tipoDeuda: 'PRESTAMO',
        montoTotal: 15000000,
        montoInicial: 15000000,
        saldoRestante: 11300000,
        saldoPrincipal: 10500000,
        cuotaPeriodo: 520000,
        tasaInteres: 22.0,
        tasaInteresAplicada: 1.67,
        tasaInteresMensual: 1.67,
        acreedor: 'Davivienda',
        frecuenciaPago: 'mensual',
        diasPago: '15',
        pagadoEstePeriodo: true,
        montoPagadoEstePeriodo: 520000,
        estado: 'activa',
        prioridad: 'media',
        bankEntityId: davivienda.id,
        pagoAutomatico: true,
      },
      {
        userId: user.id,
        nombre: 'Tarjeta Nu Colombia',
        tipoDeuda: 'TARJETA_CREDITO',
        montoTotal: 3000000,
        montoInicial: 3000000,
        saldoRestante: 1450000,
        saldoPrincipal: 1300000,
        cuotaPeriodo: 280000,
        tasaInteres: 28.0,
        tasaInteresAplicada: 2.08,
        tasaInteresMensual: 2.08,
        diaCorte: 12,
        acreedor: 'Nu Colombia',
        frecuenciaPago: 'mensual',
        diasPago: '28',
        pagadoEstePeriodo: false,
        estado: 'activa',
        prioridad: 'alta',
        bankEntityId: nubank.id,
        pagoAutomatico: false,
      },
    ],
  })
  console.log('  ✅ 3 deudas activas creadas')

  // ─── Gastos Fijos ───────────────────────────────────────────────────────────
  await prisma.fixedExpense.createMany({
    data: [
      { userId: user.id, nombre: 'Arriendo', monto: 1500000, categoria: 'vivienda', fechaCorte: '1', frecuencia: 'mensual', pagadoEstePeriodo: true, montoPagadoEstePeriodo: 1500000 },
      { userId: user.id, nombre: 'Administración', monto: 280000, categoria: 'vivienda', fechaCorte: '5', frecuencia: 'mensual', pagadoEstePeriodo: true, montoPagadoEstePeriodo: 280000 },
      { userId: user.id, nombre: 'ETB Internet + TV', monto: 135000, categoria: 'internet', fechaCorte: '10', frecuencia: 'mensual', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Claro Celular', monto: 65000, categoria: 'servicios', fechaCorte: '15', frecuencia: 'mensual', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Energía Enel', monto: 180000, categoria: 'servicios', fechaCorte: '20', frecuencia: 'mensual', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Agua EPM', monto: 85000, categoria: 'servicios', fechaCorte: '18', frecuencia: 'mensual', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Gas Vanti', monto: 45000, categoria: 'servicios', fechaCorte: '22', frecuencia: 'mensual', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Spotify Premium', monto: 17900, categoria: 'suscripciones', fechaCorte: '8', frecuencia: 'mensual', pagadoEstePeriodo: true, montoPagadoEstePeriodo: 17900, renovacionAuto: true },
      { userId: user.id, nombre: 'Netflix', monto: 32900, categoria: 'suscripciones', fechaCorte: '12', frecuencia: 'mensual', pagadoEstePeriodo: true, montoPagadoEstePeriodo: 32900, renovacionAuto: true },
      { userId: user.id, nombre: 'Gimnasio SmartFit', monto: 89900, categoria: 'salud', fechaCorte: '1', frecuencia: 'mensual', pagadoEstePeriodo: true, montoPagadoEstePeriodo: 89900, renovacionAuto: true },
    ],
  })
  console.log('  ✅ 10 gastos fijos creados')

  // ─── Gastos Hormiga (últimas 3 semanas — para proyecciones de IA) ───────────
  const now = new Date()
  const impulseData = []
  const gastos = [
    { nombre: 'Café Juan Valdez', monto: 8500, categoria: 'cafe' },
    { nombre: 'Empanadas', monto: 6000, categoria: 'comida' },
    { nombre: 'Rappi domicilio', monto: 35000, categoria: 'comida' },
    { nombre: 'Uber al trabajo', monto: 12000, categoria: 'transporte' },
    { nombre: 'Cerveza con amigos', monto: 45000, categoria: 'salida' },
    { nombre: 'Snacks D1', monto: 15000, categoria: 'antojo' },
    { nombre: 'Almuerzo corrientazo', monto: 16000, categoria: 'comida' },
    { nombre: 'Café Starbucks', monto: 18500, categoria: 'cafe' },
    { nombre: 'TransMilenio recarga', monto: 50000, categoria: 'transporte' },
    { nombre: 'Helado Crepes', monto: 12000, categoria: 'antojo' },
    { nombre: 'Pizza Dominos', monto: 42000, categoria: 'comida' },
    { nombre: 'Uber Eats sushi', monto: 58000, categoria: 'comida' },
    { nombre: 'Cerveza artesanal', monto: 25000, categoria: 'salida' },
    { nombre: 'Café oficina', monto: 5000, categoria: 'cafe' },
    { nombre: 'Brownie panadería', monto: 7500, categoria: 'antojo' },
    { nombre: 'Parqueadero CC', monto: 8000, categoria: 'transporte' },
    { nombre: 'Cigarrillos', monto: 12000, categoria: 'antojo' },
    { nombre: 'Jugo Hit tienda', monto: 3500, categoria: 'antojo' },
    { nombre: 'Almuerzo Wok', monto: 32000, categoria: 'comida' },
    { nombre: 'Café oma', monto: 9500, categoria: 'cafe' },
    { nombre: 'Cover bar', monto: 30000, categoria: 'salida' },
    { nombre: 'Taxi noche', monto: 22000, categoria: 'transporte' },
    { nombre: 'Mecato cine', monto: 28000, categoria: 'salida' },
    { nombre: 'Sandwich Subway', monto: 19500, categoria: 'comida' },
    { nombre: 'Café tinto', monto: 2500, categoria: 'cafe' },
    { nombre: 'Galletas Noel', monto: 5500, categoria: 'antojo' },
    { nombre: 'Uber regreso', monto: 15000, categoria: 'transporte' },
    { nombre: 'Hamburguesa El Corral', monto: 38000, categoria: 'comida' },
  ]

  // Distribuir gastos en los últimos 21 días (3 semanas)
  for (let i = 0; i < gastos.length; i++) {
    const daysAgo = Math.floor(Math.random() * 21)
    const date = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)
    const periodo = date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    impulseData.push({
      userId: user.id,
      nombre: gastos[i].nombre,
      monto: gastos[i].monto,
      categoria: gastos[i].categoria,
      periodo,
      createdAt: date,
    })
  }

  await prisma.impulseExpense.createMany({ data: impulseData })
  console.log(`  ✅ ${impulseData.length} gastos hormiga creados (últimas 3 semanas)`)

  // ─── Historial de Ahorro (4 meses) ─────────────────────────────────────────
  const months = ['mayo 2026', 'junio 2026', 'julio 2026', 'agosto 2026']
  await prisma.savingsHistory.createMany({
    data: months.map((periodo, i) => ({
      userId: user.id,
      periodo,
      monto: [800000, 650000, 900000, 750000][i],
      tipo: 'ahorro',
      createdAt: new Date(2026, 4 + i, 28),
    })),
  })
  console.log('  ✅ Historial de ahorro (4 meses)')

  // ─── Fondo de Emergencia — Historial ────────────────────────────────────────
  await prisma.emergencyFundHistory.createMany({
    data: [
      { userId: user.id, periodo: 'mayo 2026', monto: 500000, tipo: 'aporte', nota: 'Inicio del fondo' },
      { userId: user.id, periodo: 'junio 2026', monto: 600000, tipo: 'aporte', nota: 'Aporte mensual' },
      { userId: user.id, periodo: 'julio 2026', monto: 700000, tipo: 'aporte', nota: 'Bono extra' },
      { userId: user.id, periodo: 'julio 2026', monto: 200000, tipo: 'retiro', nota: 'Emergencia médica' },
      { userId: user.id, periodo: 'agosto 2026', monto: 500000, tipo: 'aporte', nota: 'Reponer retiro' },
    ],
  })
  console.log('  ✅ Historial fondo de emergencia')

  // ─── Ingresos Extra ─────────────────────────────────────────────────────────
  await prisma.extraIncome.createMany({
    data: [
      { userId: user.id, nombre: 'Freelance diseño web', monto: 1500000, temporalidad: 'indefinido' },
      { userId: user.id, nombre: 'Clases de inglés', monto: 800000, temporalidad: 'definido', mesesRestantes: 4 },
    ],
  })
  console.log('  ✅ Ingresos extra')

  // ─── Income Records (registros de ingresos reales) ──────────────────────────
  await prisma.incomeRecord.createMany({
    data: [
      { userId: user.id, monto: 4200000, tipo: 'salario', aAhorro: 630000, aObligaciones: 2100000, aLibre: 1050000, aEndeudamiento: 420000, createdAt: new Date(2026, 7, 1) },
      { userId: user.id, monto: 4200000, tipo: 'salario', aAhorro: 630000, aObligaciones: 2100000, aLibre: 1050000, aEndeudamiento: 420000, createdAt: new Date(2026, 6, 15) },
      { userId: user.id, monto: 1500000, tipo: 'extra', aAhorro: 750000, aObligaciones: 0, aLibre: 450000, aEndeudamiento: 300000, createdAt: new Date(2026, 6, 20) },
    ],
  })
  console.log('  ✅ Income records')

  // ─── Bolsillos de Ahorro Personales ─────────────────────────────────────────
  await prisma.savingsPocket.createMany({
    data: [
      { userId: user.id, nombre: 'Viaje a Cartagena', meta: 3000000, montoActual: 1200000, color: '#3B82F6', icono: 'plane' },
      { userId: user.id, nombre: 'MacBook Pro', meta: 8000000, montoActual: 2500000, color: '#8B5CF6', icono: 'laptop' },
      { userId: user.id, nombre: 'Fondo para navidad', meta: 2000000, montoActual: 850000, color: '#EF4444', icono: 'gift' },
      { userId: user.id, nombre: 'Curso AWS', meta: 500000, montoActual: 350000, color: '#F59E0B', icono: 'book' },
    ],
  })
  console.log('  ✅ 4 bolsillos de ahorro personales')

  // ─── Categorías de Presupuesto ──────────────────────────────────────────────
  await prisma.budgetCategory.createMany({
    data: [
      { userId: user.id, nombre: 'Vivienda', icono: 'home', color: '#6366F1', tipo: 'gasto' },
      { userId: user.id, nombre: 'Alimentación', icono: 'utensils', color: '#F59E0B', tipo: 'gasto' },
      { userId: user.id, nombre: 'Transporte', icono: 'car', color: '#3B82F6', tipo: 'gasto' },
      { userId: user.id, nombre: 'Servicios', icono: 'zap', color: '#10B981', tipo: 'gasto' },
      { userId: user.id, nombre: 'Ocio', icono: 'gamepad-2', color: '#EC4899', tipo: 'gasto' },
      { userId: user.id, nombre: 'Salud', icono: 'heart-pulse', color: '#EF4444', tipo: 'gasto' },
      { userId: user.id, nombre: 'Educación', icono: 'graduation-cap', color: '#8B5CF6', tipo: 'gasto' },
      { userId: user.id, nombre: 'Ahorro', icono: 'piggy-bank', color: '#10B981', tipo: 'ahorro' },
      { userId: user.id, nombre: 'Freelance', icono: 'briefcase', color: '#06B6D4', tipo: 'ingreso' },
      { userId: user.id, nombre: 'Salario', icono: 'banknote', color: '#22C55E', tipo: 'ingreso' },
    ],
  })
  console.log('  ✅ 10 categorías de presupuesto')

  // ─── Insignias (nivel 4 = varias desbloqueadas) ─────────────────────────────
  const badges = [
    'first_savings', 'streak_7', 'streak_14', 'emergency_fund_started',
    'debt_paid_first', 'impulse_control_week', 'budget_master',
    'income_registered', 'social_connected', 'pocket_created',
  ]
  await prisma.userBadge.createMany({
    data: badges.map(badgeId => ({ userId: user.id, badgeId })),
    skipDuplicates: true,
  })
  console.log(`  ✅ ${badges.length} insignias desbloqueadas (nivel 4)`)

  // ─── Resumen ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('✨ Usuario de prueba avanzado creado exitosamente!')
  console.log('═'.repeat(60))
  console.log('')
  console.log('  📧 Email:     test@kiri.app')
  console.log('  🔑 Password:  Test1234!')
  console.log('  👤 Nombre:    Carlos Mendoza')
  console.log('  💰 Ingreso:   $4,200,000 COP (quincenal)')
  console.log('  🏦 Deudas:    3 activas ($17,950,000 total)')
  console.log('  📋 Fijos:     10 gastos fijos')
  console.log('  🐛 Hormiga:   28 gastos (últimas 3 semanas)')
  console.log('  🐷 Bolsillos: 4 metas de ahorro')
  console.log('  📊 Categorías: 10 de presupuesto')
  console.log('  🏆 Badges:    10 insignias (nivel 4)')
  console.log('  🔥 Streak:    12 días actual / 18 mejor')
  console.log('  🛡️  Emergencia: $2,100,000')
  console.log('')
  console.log('  Wallet:')
  console.log('    💼 Ahorro:        $630,000')
  console.log('    📋 Obligaciones:  $2,100,000')
  console.log('    🎯 Libre:         $1,050,000')
  console.log('    📈 Endeudamiento: $420,000')
  console.log('')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
