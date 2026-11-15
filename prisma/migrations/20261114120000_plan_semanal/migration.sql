-- Plan semanal de gasto (Billetera)
CREATE TABLE IF NOT EXISTS "semanas_plan" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "indice" INTEGER NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3) NOT NULL,
    "meta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "congelada" BOOLEAN NOT NULL DEFAULT false,
    "congelada_at" TIMESTAMP(3),
    "gastado" DECIMAL(12,2),
    "estado" TEXT NOT NULL DEFAULT 'abierta',
    "monedas" INTEGER NOT NULL DEFAULT 0,
    "cerrada_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "semanas_plan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "semanas_plan_user_id_periodo_indice_key" ON "semanas_plan"("user_id", "periodo", "indice");
CREATE INDEX IF NOT EXISTS "semanas_plan_estado_fin_idx" ON "semanas_plan"("estado", "fin");

DO $$ BEGIN
  ALTER TABLE "semanas_plan" ADD CONSTRAINT "semanas_plan_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
