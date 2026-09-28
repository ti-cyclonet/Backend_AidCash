-- Cuota distinta solo para un periodo ("Solo este mes" al editar la cuota).
ALTER TABLE "debts" ADD COLUMN "cuota_override" DECIMAL(12,2);
ALTER TABLE "debts" ADD COLUMN "cuota_override_periodo" TEXT;
