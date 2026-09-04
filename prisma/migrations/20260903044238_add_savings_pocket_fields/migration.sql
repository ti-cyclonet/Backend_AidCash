-- AlterTable
ALTER TABLE "savings_pockets" ADD COLUMN     "descripcion" TEXT,
ADD COLUMN     "fecha_limite" TEXT,
ADD COLUMN     "pago_automatico" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tipo_meta" TEXT NOT NULL DEFAULT 'libre';
