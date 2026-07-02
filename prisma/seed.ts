import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Crear usuario demo
  const passwordHash = await bcrypt.hash('demo123', 12)

  const user = await prisma.user.upsert({
    where: { correo: 'demo@kiri.app' },
    update: {},
    create: {
      nombre: 'Alex Demo',
      correo: 'demo@kiri.app',
      passwordHash,
      ingresoBase: 3500,
      frecuenciaIngreso: 'mensual',
      onboardingDone: true,
      metaAhorroGlobal: 10000,
      saldoAhorroTotal: 4500,
      fondoEmergenciaActual: 1200,
      streakActual: 3,
      streakMejor: 7,
    },
  })

  console.log(`  ✅ Usuario: ${user.correo}`)

  // Deudas de ejemplo
  await prisma.debt.createMany({
    data: [
      {
        userId: user.id,
        nombre: 'Tarjeta Visa',
        montoTotal: 2500,
        cuotaPeriodo: 350,
        fechaVencimiento: '2025-01-15',
        pagadoEstePeriodo: false,
        estado: 'activa',
      },
      {
        userId: user.id,
        nombre: 'Préstamo Personal',
        montoTotal: 5000,
        cuotaPeriodo: 500,
        fechaVencimiento: '2025-01-20',
        pagadoEstePeriodo: false,
        estado: 'activa',
      },
    ],
    skipDuplicates: true,
  })
  console.log('  ✅ Deudas creadas')

  // Gastos fijos
  await prisma.fixedExpense.createMany({
    data: [
      { userId: user.id, nombre: 'Renta', monto: 800, fechaCorte: '2025-01-01', pagadoEstePeriodo: true },
      { userId: user.id, nombre: 'Internet', monto: 50, fechaCorte: '2025-01-10', pagadoEstePeriodo: false },
      { userId: user.id, nombre: 'Netflix', monto: 15, fechaCorte: '2025-01-05', pagadoEstePeriodo: true },
    ],
    skipDuplicates: true,
  })
  console.log('  ✅ Gastos fijos creados')

  // Historial de ahorro
  await prisma.savingsHistory.createMany({
    data: [
      { userId: user.id, periodo: 'diciembre 2024', monto: 700, tipo: 'ahorro' },
      { userId: user.id, periodo: 'noviembre 2024', monto: 650, tipo: 'ahorro' },
      { userId: user.id, periodo: 'octubre 2024', monto: 0, tipo: 'sin_ahorro' },
      { userId: user.id, periodo: 'septiembre 2024', monto: 700, tipo: 'ahorro' },
    ],
    skipDuplicates: true,
  })
  console.log('  ✅ Historial de ahorro creado')

  // Ingresos extra
  await prisma.extraIncome.createMany({
    data: [
      { userId: user.id, nombre: 'Freelance diseño', monto: 500, temporalidad: 'indefinido', mesesRestantes: null },
    ],
    skipDuplicates: true,
  })
  console.log('  ✅ Ingresos extra creados')

  // Gastos hormiga
  await prisma.impulseExpense.createMany({
    data: [
      { userId: user.id, nombre: 'Café Starbucks', monto: 5.50, categoria: 'cafe', periodo: 'enero 2025' },
      { userId: user.id, nombre: 'Snacks tienda', monto: 3.20, categoria: 'antojo', periodo: 'enero 2025' },
    ],
    skipDuplicates: true,
  })
  console.log('  ✅ Gastos hormiga creados')

  // Badge de ejemplo
  await prisma.userBadge.upsert({
    where: { userId_badgeId: { userId: user.id, badgeId: 'first_savings' } },
    create: { userId: user.id, badgeId: 'first_savings' },
    update: {},
  })
  console.log('  ✅ Insignias desbloqueadas')

  console.log('\n✨ Seed completado!')
  console.log(`   Login: demo@kiri.app / demo123`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
