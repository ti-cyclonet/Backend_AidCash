-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "budget_category_id" TEXT;

-- AlterTable
ALTER TABLE "fixed_expenses" ADD COLUMN     "budget_category_id" TEXT;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_budget_category_id_fkey" FOREIGN KEY ("budget_category_id") REFERENCES "budget_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_expenses" ADD CONSTRAINT "fixed_expenses_budget_category_id_fkey" FOREIGN KEY ("budget_category_id") REFERENCES "budget_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
