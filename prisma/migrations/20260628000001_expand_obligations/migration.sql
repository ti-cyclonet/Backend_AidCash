-- Expandir modelo Debt
ALTER TABLE "debts" ADD COLUMN "tasa_interes" DECIMAL(5,2);
ALTER TABLE "debts" ADD COLUMN "prioridad" TEXT NOT NULL DEFAULT 'media';
ALTER TABLE "debts" ADD COLUMN "acreedor" TEXT;
ALTER TABLE "debts" ADD COLUMN "cuotas_restantes" INTEGER;
ALTER TABLE "debts" ADD COLUMN "fecha_estimada_pago" TEXT;

-- Expandir modelo FixedExpense
ALTER TABLE "fixed_expenses" ADD COLUMN "categoria" TEXT NOT NULL DEFAULT 'otro';
ALTER TABLE "fixed_expenses" ADD COLUMN "frecuencia" TEXT NOT NULL DEFAULT 'mensual';
ALTER TABLE "fixed_expenses" ADD COLUMN "metodo_pago" TEXT;
ALTER TABLE "fixed_expenses" ADD COLUMN "renovacion_auto" BOOLEAN NOT NULL DEFAULT false;
