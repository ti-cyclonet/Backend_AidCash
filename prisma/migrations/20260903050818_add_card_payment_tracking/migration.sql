-- AlterTable
ALTER TABLE "debt_payments" ADD COLUMN     "installment_id" TEXT,
ADD COLUMN     "tarjeta_id" TEXT;

-- AlterTable
ALTER TABLE "fixed_expense_payments" ADD COLUMN     "installment_id" TEXT,
ADD COLUMN     "tarjeta_id" TEXT;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_tarjeta_id_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "debt_card_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_expense_payments" ADD CONSTRAINT "fixed_expense_payments_tarjeta_id_fkey" FOREIGN KEY ("tarjeta_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_expense_payments" ADD CONSTRAINT "fixed_expense_payments_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "debt_card_installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
