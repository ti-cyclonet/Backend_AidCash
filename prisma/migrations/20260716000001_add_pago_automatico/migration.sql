-- AlterTable: Add pago_automatico to debts and fixed_expenses
ALTER TABLE "debts" ADD COLUMN "pago_automatico" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fixed_expenses" ADD COLUMN "pago_automatico" BOOLEAN NOT NULL DEFAULT false;
