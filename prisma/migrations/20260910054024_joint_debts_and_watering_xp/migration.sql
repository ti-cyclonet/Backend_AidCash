-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "connection_id" TEXT,
ADD COLUMN     "es_compartida" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "monto_participante_a" DECIMAL(12,2),
ADD COLUMN     "monto_participante_b" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "xp_from_watering" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
