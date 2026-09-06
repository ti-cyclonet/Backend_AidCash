/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Reset de Base de Datos LOCAL (desarrollo)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Vacía por completo la base apuntada por DATABASE_URL en tu .env local — pensado
 * para entornos de desarrollo, no para producción (esa usa
 * scripts/reset-production-db.sh, que corre dentro del contenedor de EC2).
 *
 * A diferencia de `prisma migrate reset`, este script no reconstruye el schema:
 * hace TRUNCATE de todas las tablas de la app (deja las de _prisma_migrations
 * intactas) y reporta el conteo de filas antes/después para que quede claro que
 * sí se vació, en vez de asumirlo.
 *
 * Uso:
 *   npx tsx scripts/reset-local-db.ts
 *
 * Se niega a correr si DATABASE_URL no contiene "localhost" — así evita que se
 * ejecute por accidente contra una base remota/producción.
 */

import { PrismaClient } from '@prisma/client'
import readline from 'readline'

const prisma = new PrismaClient()

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer) }))
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || ''
  if (!dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')) {
    console.error('✗ DATABASE_URL no apunta a localhost. Por seguridad, este script solo corre contra bases locales.')
    console.error(`  DATABASE_URL actual: ${dbUrl.replace(/:[^:@]*@/, ':****@')}`)
    process.exit(1)
  }

  console.log('⚠️  Esto va a BORRAR TODOS LOS DATOS de la base local:')
  console.log(`   ${dbUrl.replace(/:[^:@]*@/, ':****@')}\n`)

  const answer = await ask("Escribe 'RESET' para confirmar: ")
  if (answer !== 'RESET') {
    console.log('Operación cancelada.')
    process.exit(0)
  }

  // Todas las tablas de la app, en el orden del schema (los nombres son los
  // que Prisma usa en la base — @@map de cada modelo en schema.prisma).
  const tables: string[] = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `.then(rows => rows.map(r => r.tablename))

  if (tables.length === 0) {
    console.log('No se encontraron tablas — nada que borrar.')
    return
  }

  const userCountBefore = await prisma.user.count()
  console.log(`\nAntes: ${userCountBefore} usuario(s), ${tables.length} tablas encontradas.`)

  const quoted = tables.map(t => `"${t}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`)

  const userCountAfter = await prisma.user.count()
  if (userCountAfter !== 0) {
    console.error(`✗ El reset NO se completó: quedan ${userCountAfter} usuario(s). Revisa el error de arriba.`)
    process.exit(1)
  }

  console.log(`✅ Listo — ${tables.length} tablas vaciadas. Usuarios: ${userCountBefore} → 0.`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
