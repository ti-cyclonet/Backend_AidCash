-- Programa de invitados nuevo (prueba de 14 días para el invitado, bono de
-- Kiri Coach al activarse, niveles sin tope) y minijuego del árbol.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "xp_from_jardin" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "prueba_pro_hasta" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referido_activado_en" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ai_bonos" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_bonos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ai_bonos_user_id_periodo_idx" ON "ai_bonos"("user_id", "periodo");
DO $$ BEGIN
    ALTER TABLE "ai_bonos" ADD CONSTRAINT "ai_bonos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "referido_premios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "premio" TEXT NOT NULL,
    "detalle" JSONB,
    "estado" TEXT NOT NULL DEFAULT 'entregado',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referido_premios_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "referido_premios_user_id_clave_key" ON "referido_premios"("user_id", "clave");
DO $$ BEGIN
    ALTER TABLE "referido_premios" ADD CONSTRAINT "referido_premios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "garden_cosechas" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "fecha" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "indice" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "detalle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "garden_cosechas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "garden_cosechas_user_id_fecha_tipo_indice_key" ON "garden_cosechas"("user_id", "fecha", "tipo", "indice");
DO $$ BEGIN
    ALTER TABLE "garden_cosechas" ADD CONSTRAINT "garden_cosechas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
