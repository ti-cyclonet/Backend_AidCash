-- Economía del árbol 3D: monedas, cosméticos, cofres y lo equipado
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monedas" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "jardin_equipado" JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "jardin_nivel_premiado" INTEGER;

CREATE TABLE IF NOT EXISTS "coin_ledger" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "motivo" TEXT NOT NULL,
  "ref_id" TEXT NOT NULL,
  "fecha" TEXT NOT NULL,
  "detalle" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coin_ledger_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "coin_ledger_user_id_motivo_ref_id_key" ON "coin_ledger"("user_id", "motivo", "ref_id");
CREATE INDEX IF NOT EXISTS "coin_ledger_user_id_fecha_idx" ON "coin_ledger"("user_id", "fecha");

CREATE TABLE IF NOT EXISTS "user_cosmetics" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "clave" TEXT NOT NULL,
  "origen" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_cosmetics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_cosmetics_user_id_tipo_clave_key" ON "user_cosmetics"("user_id", "tipo", "clave");

CREATE TABLE IF NOT EXISTS "user_chests" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "estado" TEXT NOT NULL DEFAULT 'pendiente',
  "origen" TEXT NOT NULL,
  "ref_id" TEXT NOT NULL,
  "premio" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "abierto_at" TIMESTAMP(3),
  CONSTRAINT "user_chests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_chests_user_id_origen_ref_id_key" ON "user_chests"("user_id", "origen", "ref_id");
CREATE INDEX IF NOT EXISTS "user_chests_user_id_estado_idx" ON "user_chests"("user_id", "estado");

DO $$ BEGIN
  ALTER TABLE "coin_ledger" ADD CONSTRAINT "coin_ledger_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "user_cosmetics" ADD CONSTRAINT "user_cosmetics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "user_chests" ADD CONSTRAINT "user_chests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
