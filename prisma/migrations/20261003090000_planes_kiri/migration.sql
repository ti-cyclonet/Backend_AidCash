-- Planes de Kiri (FREE / PLUS / PRO): prueba de PLUS, uso mensual de IA y escenarios guardados
ALTER TABLE "users" ADD COLUMN "prueba_plus_hasta" TIMESTAMP(3);

CREATE TABLE "ai_uso" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_uso_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_uso_user_id_periodo_tipo_key" ON "ai_uso"("user_id", "periodo", "tipo");
ALTER TABLE "ai_uso" ADD CONSTRAINT "ai_uso_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "proyeccion_escenarios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "aporte_extra" DECIMAL(12,2) NOT NULL,
    "recortar_hormiga" BOOLEAN NOT NULL DEFAULT false,
    "meses" INTEGER NOT NULL DEFAULT 12,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "proyeccion_escenarios_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "proyeccion_escenarios_user_id_idx" ON "proyeccion_escenarios"("user_id");
ALTER TABLE "proyeccion_escenarios" ADD CONSTRAINT "proyeccion_escenarios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
