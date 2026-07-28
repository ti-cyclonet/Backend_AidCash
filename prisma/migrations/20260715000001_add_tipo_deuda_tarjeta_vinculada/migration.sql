-- CreateEnum
CREATE TYPE "TipoDeuda" AS ENUM ('PRESTAMO', 'TARJETA_CREDITO');

-- AlterTable: debts — nuevos campos para tarjetas de crédito y amortización
ALTER TABLE "debts" ADD COLUMN "tipo_deuda" "TipoDeuda" NOT NULL DEFAULT 'PRESTAMO';
ALTER TABLE "debts" ADD COLUMN "saldo_principal" DECIMAL(12,2);
ALTER TABLE "debts" ADD COLUMN "tasa_interes_mensual" DECIMAL(7,4);
ALTER TABLE "debts" ADD COLUMN "dia_corte" INTEGER;

-- AlterTable: fixed_expenses — vinculación a tarjeta de crédito
ALTER TABLE "fixed_expenses" ADD COLUMN "tarjeta_vinculada_id" TEXT;

-- AddForeignKey
ALTER TABLE "fixed_expenses" ADD CONSTRAINT "fixed_expenses_tarjeta_vinculada_id_fkey" FOREIGN KEY ("tarjeta_vinculada_id") REFERENCES "debts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
