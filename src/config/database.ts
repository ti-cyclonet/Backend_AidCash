import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})

export async function connectDatabase() {
  try {
    await prisma.$connect()
    console.log('✅ Base de datos conectada')
  } catch (error) {
    console.error('❌ Error al conectar la base de datos:', error)
    process.exit(1)
  }
}

export async function disconnectDatabase() {
  await prisma.$disconnect()
}
