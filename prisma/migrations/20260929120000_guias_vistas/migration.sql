-- Guías/tutoriales vistos, guardados en el servidor (no por navegador)
ALTER TABLE "users" ADD COLUMN "guias_vistas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Quien ya usaba Kiri (terminó el onboarding) ya pasó por las guías: no
-- deben volver a salirle al entrar desde otro dispositivo.
UPDATE "users" SET "guias_vistas" = ARRAY['*']::TEXT[] WHERE "onboarding_done" = true;
