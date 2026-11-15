-- Medición de los planes (2026-11): ofertas vistas y tocadas, límites alcanzados y cambios de plan
CREATE TABLE "plan_eventos" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "origen" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "detalle" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_eventos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "plan_eventos_tipo_created_at_idx" ON "plan_eventos"("tipo", "created_at");
CREATE INDEX "plan_eventos_user_id_idx" ON "plan_eventos"("user_id");
ALTER TABLE "plan_eventos" ADD CONSTRAINT "plan_eventos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
