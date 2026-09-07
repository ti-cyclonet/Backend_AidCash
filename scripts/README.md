# Reset completo de la base de datos — Kiri (backend AidCash)

Script para **resetear por completo** la base de datos de Kiri y reconstruirla
con las migraciones de Prisma.

> ⚠️ **Operación destructiva e irreversible.** Borra todos los usuarios, deudas,
> ahorros, presupuestos, etc. En producción, idealmente con respaldo previo.

> ℹ️ Este backend es el de **AidCash**, desplegado como **Kiri**
> (contenedor `cyclonet-kiri-api`, base `KiriDB`). Es **Express + Prisma**.

## Cómo funciona

Kiri usa **Prisma con migraciones** (carpeta `prisma/migrations/`). El esquema
**no** se recrea por `synchronize`; se reconstruye aplicando las migraciones con
`prisma migrate deploy`. El contenedor ya corre `prisma migrate deploy` en su
arranque (ver `Dockerfile`).

Kiri **no usa extensiones de Postgres** (no postgis), por lo que basta con
`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — no hay que recrear
extensiones.

Reset de **2 pasos**: limpiar el esquema (SQL) y reconstruir con migraciones.

## Archivos

- `reset-database.sql` — `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
  (borra tablas, enums e historial de migraciones).

## Pasos

### 1. Ejecutar el SQL (TablePlus o psql)

Conéctate a la base de **Kiri** y **verifica primero**:

```sql
SELECT current_database();   -- debe decir KiriDB
```

Ejecuta el contenido de `reset-database.sql`.

### 2. Reconstruir el esquema con las migraciones

En el servidor (EC2), dentro del contenedor:

```bash
docker exec cyclonet-kiri-api npx prisma migrate deploy
docker exec cyclonet-kiri-api npx prisma migrate status   # verificar
```

> Alternativa "todo en uno": el contenedor aplica `migrate deploy` al arrancar,
> así que también puedes reconstruir con solo reiniciarlo tras el DROP:
> `docker restart cyclonet-kiri-api`.

### 3. (Opcional) Seed de datos demo

El seed (`prisma/seed.ts`, vía `tsx`) **solo crea datos de demostración**
(usuario `demo@kiri.app`), **no** datos de catálogo necesarios. Además hoy está
**desactualizado** respecto al esquema y fallaría. Por eso el seed es **opcional**
y, de necesitarse, hay que actualizarlo primero. Para una base productiva limpia,
**omite** este paso: los usuarios se registran desde cero.

Si aún así quieres correrlo (tras actualizar `seed.ts`):

```bash
docker exec cyclonet-kiri-api npx tsx prisma/seed.ts
```

## Alternativa: `prisma migrate reset`

Existe también `scripts/reset-production-db.sh` (previo) que hace lo mismo con
`prisma migrate reset --force` (dropea + re-migra en un solo comando) más un
health check. Cualquiera de los dos enfoques deja la base reconstruida; este SQL
+ `migrate deploy` es el equivalente manual y explícito.

## Entornos

| Entorno | Base de datos | Contenedor |
|---|---|---|
| Producción | `KiriDB` | `cyclonet-kiri-api` |
| Local/Dev | `kiri_finance` | (según docker-compose local) |
