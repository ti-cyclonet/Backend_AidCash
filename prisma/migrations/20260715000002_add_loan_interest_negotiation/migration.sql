-- AlterTable: loans — campos para negociación de intereses
ALTER TABLE "loans" ADD COLUMN "tasa_interes" DECIMAL(5,2);
ALTER TABLE "loans" ADD COLUMN "monto_original" DECIMAL(12,2);
