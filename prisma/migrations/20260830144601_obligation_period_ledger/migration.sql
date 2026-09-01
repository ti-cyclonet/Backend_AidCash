-- CreateTable: ledger de pagos de gastos fijos (mismo patrón que debt_payments)
CREATE TABLE "fixed_expense_payments" (
    "id" TEXT NOT NULL,
    "fixed_expense_id" TEXT NOT NULL,
    "monto_pagado" DECIMAL(12,2) NOT NULL,
    "periodo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_expense_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fixed_expense_payments_fixed_expense_id_periodo_idx" ON "fixed_expense_payments"("fixed_expense_id", "periodo");

ALTER TABLE "fixed_expense_payments" ADD CONSTRAINT "fixed_expense_payments_fixed_expense_id_fkey" FOREIGN KEY ("fixed_expense_id") REFERENCES "fixed_expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: preservar el estado "pagado este periodo" que hoy vive en columnas
-- mutables, como una fila de ledger fechada hoy, antes de eliminar esas columnas.
INSERT INTO "fixed_expense_payments" ("id", "fixed_expense_id", "monto_pagado", "periodo", "created_at")
SELECT
  gen_random_uuid(),
  "id",
  COALESCE("monto_pagado_este_periodo", "monto"),
  CASE "frecuencia"
    WHEN 'quincenal' THEN to_char(now(), 'YYYY-MM') || '-Q' || (CASE WHEN EXTRACT(DAY FROM now()) <= 15 THEN '1' ELSE '2' END)
    WHEN 'semanal' THEN to_char(now(), 'IYYY-"W"IW')
    WHEN 'anual' THEN to_char(now(), 'YYYY')
    ELSE to_char(now(), 'YYYY-MM')
  END,
  now()
FROM "fixed_expenses"
WHERE "pagado_este_periodo" = true
   OR ("monto_pagado_este_periodo" IS NOT NULL AND "monto_pagado_este_periodo" > 0);

-- Reformatear el periodo de pagos de deuda quincenales existentes: pasan de
-- "YYYY-MM" a "YYYY-MM-Q1"/"YYYY-MM-Q2" según el día en que se registró el pago,
-- para que coincidan con el nuevo formato que usa el código.
UPDATE "debt_payments" dp
SET "periodo" = dp."periodo" || '-Q' || (CASE WHEN EXTRACT(DAY FROM dp."created_at") <= 15 THEN '1' ELSE '2' END)
FROM "debts" d
WHERE dp."debt_id" = d."id"
  AND d."frecuencia_pago" = 'quincenal'
  AND dp."periodo" !~ '-Q[12]$';

-- AlterTable: las columnas mutables quedan reemplazadas por el ledger (derivado en runtime)
ALTER TABLE "debts" DROP COLUMN "monto_pagado_este_periodo",
DROP COLUMN "pagado_este_periodo";

ALTER TABLE "fixed_expenses" DROP COLUMN "monto_pagado_este_periodo",
DROP COLUMN "pagado_este_periodo";
