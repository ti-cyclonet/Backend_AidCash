-- Fecha real de pago en préstamos de Social (antes texto libre en due_date)
ALTER TABLE "loans" ADD COLUMN "fecha_compromiso" DATE;

-- Los que ya tenían una fecha válida "YYYY-MM-DD" la conservan como fecha real
UPDATE "loans" SET "fecha_compromiso" = TO_DATE("due_date", 'YYYY-MM-DD')
WHERE "due_date" ~ '^\d{4}-\d{2}-\d{2}$';
