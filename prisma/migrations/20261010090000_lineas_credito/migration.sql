-- Tarjetas y créditos de compras (Addi, Sistecrédito…) como líneas de crédito
-- con cupo: tipo nuevo, cupo, saldo del banco en los pagos y ajustes de saldo.

ALTER TYPE "TipoDeuda" ADD VALUE IF NOT EXISTS 'CREDITO_COMPRAS';

ALTER TABLE "debts" ADD COLUMN IF NOT EXISTS "cupo_total" DECIMAL(14,2);
ALTER TABLE "debt_payments" ADD COLUMN IF NOT EXISTS "saldo_banco" DECIMAL(12,2);

CREATE TABLE IF NOT EXISTS "debt_ajustes" (
    "id" TEXT NOT NULL,
    "debt_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "saldo_anterior" DECIMAL(12,2) NOT NULL,
    "saldo_posterior" DECIMAL(12,2) NOT NULL,
    "periodo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "debt_ajustes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "debt_ajustes_debt_id_periodo_idx" ON "debt_ajustes"("debt_id", "periodo");
DO $$ BEGIN
  ALTER TABLE "debt_ajustes" ADD CONSTRAINT "debt_ajustes_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Una tarjeta pagada por completo NO se termina: su cupo sigue disponible.
-- Antes quedaba "saldada" y desaparecía de los selectores de pago con tarjeta.
UPDATE "debts" SET "estado" = 'activa' WHERE "tipo_deuda" = 'TARJETA_CREDITO' AND "estado" = 'saldada';
