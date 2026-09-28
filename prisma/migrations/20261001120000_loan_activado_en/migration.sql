-- Fecha en que el préstamo quedó activo (cuando se movió la plata, o se confirmó uno previo) — para ubicarlo en Balance
ALTER TABLE "loans" ADD COLUMN "activado_en" TIMESTAMP(3);
UPDATE "loans" SET "activado_en" = "created_at" WHERE "status" IN ('ACTIVE', 'PAID');
