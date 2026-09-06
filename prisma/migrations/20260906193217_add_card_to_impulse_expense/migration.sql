-- AlterTable
ALTER TABLE "impulse_expenses" ADD COLUMN     "installment_id" TEXT,
ADD COLUMN     "tarjeta_id" TEXT;

-- AddForeignKey
ALTER TABLE "impulse_expenses" ADD CONSTRAINT "impulse_expenses_tarjeta_id_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impulse_expenses" ADD CONSTRAINT "impulse_expenses_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "debt_card_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
