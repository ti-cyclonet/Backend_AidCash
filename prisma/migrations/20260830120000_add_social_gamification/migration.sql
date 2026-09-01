-- AlterTable
ALTER TABLE "shared_pockets" ADD COLUMN     "deadline" TEXT;

-- AlterTable (username nullable primero para poder rellenar filas existentes)
ALTER TABLE "users" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "username" TEXT;

-- Backfill: username desde nombre para usuarios ya registrados (ej. el demo user)
WITH numbered AS (
  SELECT id,
    COALESCE(NULLIF(lower(regexp_replace(nombre, '[^a-zA-Z0-9]', '', 'g')), ''), 'usuario') AS base,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(lower(regexp_replace(nombre, '[^a-zA-Z0-9]', '', 'g')), ''), 'usuario')
      ORDER BY created_at
    ) AS rn
  FROM "users"
)
UPDATE "users"
SET "username" = CASE WHEN numbered.rn = 1 THEN numbered.base ELSE numbered.base || numbered.rn::text END
FROM numbered
WHERE "users"."id" = numbered.id;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;

-- CreateTable
CREATE TABLE "garden_watering" (
    "id" TEXT NOT NULL,
    "water_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "garden_watering_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "garden_watering_target_user_id_periodo_idx" ON "garden_watering"("target_user_id", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "garden_watering_water_id_target_user_id_periodo_key" ON "garden_watering"("water_id", "target_user_id", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "garden_watering" ADD CONSTRAINT "garden_watering_water_id_fkey" FOREIGN KEY ("water_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garden_watering" ADD CONSTRAINT "garden_watering_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
