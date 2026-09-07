-- =============================================================================
-- RESET COMPLETO — KiriDB   (schema: public)   [backend: AidCash / "Kiri"]
-- =============================================================================
-- ⚠️  DESTRUCTIVO E IRREVERSIBLE. Borra TODA la estructura y datos de Kiri.
--
-- ORM: Prisma con MIGRACIONES. A diferencia de Authoriza/InOut, reiniciar el
--      contenedor NO recrea el esquema por "synchronize" — se reconstruye
--      aplicando las migraciones (prisma migrate deploy). De hecho el contenedor
--      corre `prisma migrate deploy` en su arranque.
--
-- Kiri NO usa extensiones de Postgres (no postgis), así que un DROP SCHEMA +
-- CREATE SCHEMA es suficiente (no hay que recrear extensiones).
--
-- Verifica primero que estás en la base correcta:
--     SELECT current_database();   -- debe decir KiriDB
-- =============================================================================

-- Borra TODAS las tablas, tipos/enums e historial de migraciones de Kiri.
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

-- Después de este SQL, reconstruye el esquema con las migraciones de Prisma
-- (ver README.md):
--     docker exec cyclonet-kiri-api npx prisma migrate deploy
-- El seed (demo) es OPCIONAL y hoy está desactualizado — ver README.
