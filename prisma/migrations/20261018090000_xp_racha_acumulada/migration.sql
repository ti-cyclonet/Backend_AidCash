-- El árbol ya no baja de nivel al perder la racha: los días de racha se
-- guardan como XP acumulada (40 por día contado) en vez de calcularse con la
-- racha actual. Arranque: la mejor racha que tuvo cada usuario.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "xp_from_racha" INTEGER NOT NULL DEFAULT 0;
UPDATE "users" SET "xp_from_racha" = GREATEST("streak_mejor", "streak_actual") * 40 WHERE "xp_from_racha" = 0;
