-- Idioma de la app por usuario ("es" | "en")
ALTER TABLE "users" ADD COLUMN "idioma" TEXT NOT NULL DEFAULT 'es';
