-- AlterTable
ALTER TABLE "debt_card_installments" ADD COLUMN     "monto_abonado" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "debt_payment_allocations" (
    "id" TEXT NOT NULL,
    "debt_payment_id" TEXT NOT NULL,
    "installment_id" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "debt_payment_allocations_debt_payment_id_idx" ON "debt_payment_allocations"("debt_payment_id");

-- CreateIndex
CREATE INDEX "debt_payment_allocations_installment_id_idx" ON "debt_payment_allocations"("installment_id");

-- AddForeignKey
ALTER TABLE "debt_payment_allocations" ADD CONSTRAINT "debt_payment_allocations_debt_payment_id_fkey" FOREIGN KEY ("debt_payment_id") REFERENCES "debt_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payment_allocations" ADD CONSTRAINT "debt_payment_allocations_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "debt_card_installments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
