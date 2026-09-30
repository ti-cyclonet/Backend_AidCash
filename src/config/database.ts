import { PrismaClient } from '@prisma/client'

/**
 * Pool de conexiones: sin `connection_limit` Prisma abre 2 × núcleos + 1 (en
 * un servidor de 2 vCPU son 5 conexiones para TODOS los usuarios) y, con
 * muchos a la vez, las consultas hacen fila esperando conexión. Se usa
 * DB_POOL_SIZE (15 por defecto) salvo que DATABASE_URL ya lo traiga.
 * Ojo: Postgres admite 100 conexiones por defecto; con varias instancias de la
 * app, instancias × DB_POOL_SIZE debe quedar por debajo.
 */
function urlConPool(): string | undefined {
  const url = process.env.DATABASE_URL
  if (!url || /[?&]connection_limit=/.test(url)) return url
  const pool = Number(process.env.DB_POOL_SIZE) || 15
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${pool}&pool_timeout=20`
}

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  datasources: { db: { url: urlConPool() } },
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
