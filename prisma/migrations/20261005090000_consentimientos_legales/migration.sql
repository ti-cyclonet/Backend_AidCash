-- Versiones aceptadas de los Términos y Condiciones y de la autorización de
-- tratamiento de datos (la prueba legal con IP y fecha queda en Authoriza).
ALTER TABLE "users" ADD COLUMN "terminos_version" TEXT;
ALTER TABLE "users" ADD COLUMN "datos_version" TEXT;
ALTER TABLE "users" ADD COLUMN "consentimiento_at" TIMESTAMP(3);
