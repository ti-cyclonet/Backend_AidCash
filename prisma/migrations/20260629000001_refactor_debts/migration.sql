-- Refactorizar modelo Debt: agregar saldo_restante, frecuencia_pago, dias_pago
-- y eliminar campos obsoletos

-- Agregar nuevos campos
ALTER TABLE "debts" ADD COLUMN "saldo_restante" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "debts" ADD COLUMN "frecuencia_pago" TEXT NOT NULL DEFAULT 'mensual';
ALTER TABLE "debts" ADD COLUMN "dias_pago" TEXT NOT NULL DEFAULT '1';

-- Migrar datos: saldo_restante = monto_total para deudas activas
UPDATE "debts" SET "saldo_restante" = "monto_total" WHERE "estado" = 'activa';
UPDATE "debts" SET "saldo_restante" = 0 WHERE "estado" = 'saldada';

-- Migrar acreedor: si es null, poner vacío
UPDATE "debts" SET "acreedor" = '' WHERE "acreedor" IS NULL;
ALTER TABLE "debts" ALTER COLUMN "acreedor" SET NOT NULL;
ALTER TABLE "debts" ALTER COLUMN "acreedor" SET DEFAULT '';

-- Migrar dias_pago desde fecha_vencimiento (extraer el día)
UPDATE "debts" SET "dias_pago" = 
  CASE 
    WHEN "fecha_vencimiento" LIKE '%-%' THEN 
      CAST(CAST(SPLIT_PART("fecha_vencimiento", '-', 3) AS INTEGER) AS TEXT)
    ELSE "fecha_vencimiento"
  END
WHERE "fecha_vencimiento" IS NOT NULL AND "fecha_vencimiento" != '';

-- Eliminar campos obsoletos
ALTER TABLE "debts" DROP COLUMN IF EXISTS "fecha_vencimiento";
ALTER TABLE "debts" DROP COLUMN IF EXISTS "cuotas_restantes";
ALTER TABLE "debts" DROP COLUMN IF EXISTS "fecha_estimada_pago";
