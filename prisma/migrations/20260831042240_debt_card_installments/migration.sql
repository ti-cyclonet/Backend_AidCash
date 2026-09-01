-- CreateTable
CREATE TABLE "debt_card_installments" (
    "id" TEXT NOT NULL,
    "tarjeta_id" TEXT NOT NULL,
    "cuota_mensual" DECIMAL(12,2) NOT NULL,
    "cuotas_total" INTEGER NOT NULL,
    "descripcion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_card_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debt_card_installments_tarjeta_id_idx" ON "debt_card_installments"("tarjeta_id");

-- AddForeignKey
ALTER TABLE "debt_card_installments" ADD CONSTRAINT "debt_card_installments_tarjeta_id_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
