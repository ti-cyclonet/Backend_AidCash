-- Pagos "marcador" (el usuario declaró que la cuota del periodo ya estaba
-- pagada por fuera de Kiri) y clasificación explícita de gasto hormiga.

ALTER TABLE "debt_payments" ADD COLUMN "es_marcador" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "fixed_expense_payments" ADD COLUMN "es_marcador" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "impulse_expenses" ADD COLUMN "es_hormiga" BOOLEAN NOT NULL DEFAULT false;

-- Backfill de marcadores de deuda: un pago real SIEMPRE reparte su monto entre
-- interés y capital (pago_interes + abono_capital = monto_pagado); el marcador
-- sembrado por POST /debts con yaPagoEstePeriodo es el único con ambos en 0.
UPDATE "debt_payments"
SET "es_marcador" = true
WHERE "abono_capital" = 0 AND "pago_interes" = 0 AND "monto_pagado" > 0 AND "tarjeta_id" IS NULL;

-- Backfill de marcadores de gasto fijo: el marcador se crea en la MISMA
-- transacción que el gasto fijo, así que su created_at es prácticamente igual.
UPDATE "fixed_expense_payments" p
SET "es_marcador" = true
FROM "fixed_expenses" f
WHERE p."fixed_expense_id" = f."id"
  AND p."tarjeta_id" IS NULL
  AND ABS(EXTRACT(EPOCH FROM (p."created_at" - f."created_at"))) < 10;

-- Backfill de gasto hormiga: misma regla que src/lib/hormiga.ts (monto chico
-- o palabra clave), más todo lo que ya venía marcado con el 🐜 legacy.
UPDATE "impulse_expenses"
SET "es_hormiga" = true
WHERE "nombre" LIKE '🐜%'
   OR ("monto" > 0 AND "monto" <= 50000)
   OR LOWER("nombre") ~ '(^|[^a-záéíóúñ])(comida rápida|comida rapida|transmilenio|hamburguesa|juan valdez|parqueadero|impresion|fotocopia|didi food|uber eats|domicilio|chocolate|starbucks|capuchino|in driver|impresión|golosina|empanada|espresso|almuerzo|sandwich|desayuno|indriver|vending|cerveza|propina|perrito|recarga|galleta|gaseosa|buñuelo|bunuelo|boleta|cabify|helado|pasaje|postre|chicle|antojo|arepa|latte|papas|perro|trago|picap|rappi|metro|pizza|tinto|cover|peaje|snack|dulce|ifood|café|uber|jugo|cine|didi|cafe|taxi|bus)';

-- El 🐜 ya no se usa como marca dentro del nombre.
UPDATE "impulse_expenses"
SET "nombre" = regexp_replace("nombre", '^🐜\s*', '')
WHERE "nombre" LIKE '🐜%';
