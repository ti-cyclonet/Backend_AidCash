# Reset de la base de datos — Kiri (backend AidCash)

Scripts para **resetear por completo** la base de datos de Kiri.

> ⚠️ **Operación destructiva e irreversible.** Borra todos los usuarios, deudas,
> ahorros, presupuestos, conexiones sociales, préstamos e historial. En
> producción, idealmente con respaldo previo.

> ℹ️ Este backend es el de **AidCash**, desplegado como **Kiri**
> (contenedor `cyclonet-kiri-api`, base `KiriDB`). Es **Express + Prisma** con
> migraciones (`prisma/migrations/`). No usa extensiones de Postgres (no postgis).

## Scripts disponibles

| Script | Entorno | Qué hace |
|---|---|---|
| `reset-production-db.sh` | **Producción** | Corre dentro del contenedor de la EC2: `prisma migrate reset --force` (dropea + re-migra), verifica que la tabla de usuarios quedó en 0, reinicia el contenedor y hace health check. |
| `reset-local-db.ts` | **Local / desarrollo** | `TRUNCATE` de todas las tablas de la app (con guarda: se niega a correr si `DATABASE_URL` no es localhost). |

## Producción — `reset-production-db.sh`

Este script **no** se conecta por túnel desde tu máquina: te conectas por SSH al
servidor y el script corre ahí, usando `docker exec` sobre el contenedor (que ya
tiene el `DATABASE_URL` de `KiriDB`). Por eso no requiere credenciales locales.

```bash
# 1. Conéctate a la EC2
ssh -i C:\Users\AlfredoMamby\cyclonet-ec2-key.pem ec2-user@3.95.90.144

# 2. Ubícate en el backend y ejecuta el script
cd /opt/cyclonet/AidCash/Backend_AidCash
bash scripts/reset-production-db.sh
```

El script pide confirmación (hay que escribir `RESET`) y hace:

1. Verifica que el contenedor `cyclonet-kiri-api` esté corriendo.
2. `prisma migrate reset --force` dentro del contenedor (reconstruye el esquema).
3. `prisma migrate status` para confirmar las migraciones.
4. Verifica que la tabla `User` quedó en **0 filas** (aborta si no).
5. Reinicia el contenedor y hace health check en `/api/health`.

> El contenedor además aplica `prisma migrate deploy` en su arranque (ver
> `Dockerfile`), así que el esquema siempre queda consistente al reiniciar.

### Seed

El seed (`prisma/seed.ts`, vía `tsx`) solo crea **datos demo** y hoy está
**desactualizado** respecto al esquema (fallaría). Por eso NO se ejecuta en el
reset de producción: la base queda limpia y los usuarios se registran desde cero.

## Local — `reset-local-db.ts`

Para vaciar tu base de desarrollo (definida por `DATABASE_URL` en tu `.env`
local). Tiene una guarda de seguridad: **solo corre si el host es `localhost` /
`127.0.0.1`**, para no tocar remoto por accidente.

```bash
npx tsx scripts/reset-local-db.ts
```

Pide confirmación (`RESET`), hace `TRUNCATE ... RESTART IDENTITY CASCADE` de todas
las tablas de la app (deja intacta `_prisma_migrations`) y reporta el conteo
antes/después.

## Entornos

| Entorno | Base de datos | Contenedor / ejecución |
|---|---|---|
| Producción | `KiriDB` | `cyclonet-kiri-api` (vía `reset-production-db.sh` en la EC2) |
| Local/Dev | `kiri_finance` | `reset-local-db.ts` con `.env` local |
