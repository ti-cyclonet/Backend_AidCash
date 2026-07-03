-- Track the exact amount paid each period (may differ from cuota_periodo)
ALTER TABLE "debts" ADD COLUMN "monto_pagado_este_periodo" DECIMAL(12, 2);
-- Also add vencido_desde if not exists (from earlier migration that may not have run)
ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "vencido_desde" TIMESTAMP(3);
