-- AlterTable: add cash_balance column to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cash_balance" DECIMAL(12,2) NOT NULL DEFAULT 0;
