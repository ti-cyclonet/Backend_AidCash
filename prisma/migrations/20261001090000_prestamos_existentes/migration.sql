-- Préstamos que ya existían antes de Kiri: se registran sin mover plata de ninguna billetera
ALTER TABLE "loans" ADD COLUMN "sin_desembolso" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "loans" ADD COLUMN "creado_por_id" TEXT;
