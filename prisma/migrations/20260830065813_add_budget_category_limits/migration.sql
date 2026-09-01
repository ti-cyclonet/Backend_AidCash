-- AlterTable
ALTER TABLE "budget_categories" ADD COLUMN     "linked_fixed_expense_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "monto_limite" DECIMAL(12,2) NOT NULL DEFAULT 0;
