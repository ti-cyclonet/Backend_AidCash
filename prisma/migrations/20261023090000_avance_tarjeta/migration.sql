-- Avance de tarjeta de crédito: el ingreso a la billetera queda enlazado al
-- plan de cuotas (monto + comisión) que se cargó en la tarjeta.
ALTER TABLE "income_records" ADD COLUMN IF NOT EXISTS "installment_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "income_records" ADD CONSTRAINT "income_records_installment_id_fkey"
    FOREIGN KEY ("installment_id") REFERENCES "debt_card_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
