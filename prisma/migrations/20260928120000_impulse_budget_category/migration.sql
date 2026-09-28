-- Categoría de presupuesto como FK real en los gastos variables (antes era
-- una etiqueta de texto dentro del nombre + detección por palabras clave).

ALTER TABLE "impulse_expenses" ADD COLUMN "budget_category_id" TEXT;
ALTER TABLE "impulse_expenses" ADD CONSTRAINT "impulse_expenses_budget_category_id_fkey"
  FOREIGN KEY ("budget_category_id") REFERENCES "budget_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "impulse_expenses_budget_category_id_idx" ON "impulse_expenses"("budget_category_id");

-- 1. Etiqueta al inicio: "[Transporte] InDriver" → categoría + nombre limpio.
UPDATE "impulse_expenses" ie
SET "budget_category_id" = bc."id",
    "nombre" = CASE WHEN btrim(regexp_replace(ie."nombre", '^\s*\[[^\]]+\]\s*', '')) = '' THEN ie."nombre"
                    ELSE btrim(regexp_replace(ie."nombre", '^\s*\[[^\]]+\]\s*', '')) END
FROM "budget_categories" bc
WHERE ie."user_id" = bc."user_id"
  AND ie."budget_category_id" IS NULL
  AND translate(lower(substring(ie."nombre" from '^\s*\[([^\]]+)\]')), 'áéíóúüñ', 'aeiouun') = translate(lower(btrim(bc."nombre")), 'áéíóúüñ', 'aeiouun');

-- 2. Etiqueta al final: "InDriver [Transporte]".
UPDATE "impulse_expenses" ie
SET "budget_category_id" = bc."id",
    "nombre" = CASE WHEN btrim(regexp_replace(ie."nombre", '\s*\[[^\]]+\]\s*$', '')) = '' THEN ie."nombre"
                    ELSE btrim(regexp_replace(ie."nombre", '\s*\[[^\]]+\]\s*$', '')) END
FROM "budget_categories" bc
WHERE ie."user_id" = bc."user_id"
  AND ie."budget_category_id" IS NULL
  AND translate(lower(substring(ie."nombre" from '\[([^\]]+)\]\s*$')), 'áéíóúüñ', 'aeiouun') = translate(lower(btrim(bc."nombre")), 'áéíóúüñ', 'aeiouun');

-- 3. Sin etiqueta: mismas palabras clave que src/lib/categorias.ts (palabra
--    completa: "gas" ya no calza con "gasolina"), o el nombre de la categoría
--    dentro de la descripción. Antes esto se calculaba al vuelo en cada
--    pantalla; ahora queda fijo y el usuario lo puede corregir.
WITH kw("cat", "rx") AS (
  VALUES
    ('vivienda', '(^|[^a-z0-9])(administracion|arreglo casa|arriendo|hipoteca|muebles|renta)s?([^a-z0-9]|$)'),
    ('alimentacion', '(^|[^a-z0-9])(supermercado|restaurante|hamburguesa|cafeteria|domicilio|almuerzo|desayuno|empanada|mercado|bunuelo|perrito|comida|snack|pizza|pollo|arroz|rappi|arepa|cena)s?([^a-z0-9]|$)'),
    ('transporte', '(^|[^a-z0-9])(mantenimiento|transmilenio|parqueadero|gasolina|indriver|cabify|lavada|aceite|llanta|pasaje|picap|peaje|metro|uber|didi|taxi|moto|bus)s?([^a-z0-9]|$)'),
    ('servicios', '(^|[^a-z0-9])(plan datos|streaming|internet|telefono|celular|agua|luz|gas)s?([^a-z0-9]|$)'),
    ('deudas', '(^|[^a-z0-9])(prestamo|tarjeta|credito|interes|cuota|banco)s?([^a-z0-9]|$)'),
    ('ocio', '(^|[^a-z0-9])(discoteca|netflix|spotify|cerveza|fiesta|salida|juego|trago|cine|bar)s?([^a-z0-9]|$)'),
    ('salud', '(^|[^a-z0-9])(cita medica|odontologo|drogueria|farmacia|hospital|cirugia|medico|doctor|lentes|examen)s?([^a-z0-9]|$)'),
    ('familia', '(^|[^a-z0-9])(regalo familia|guarderia|colegio|juguete|mesada|hijos|papa|mama)s?([^a-z0-9]|$)'),
    ('educacion', '(^|[^a-z0-9])(capacitacion|universidad|matricula|diplomado|idiomas|curso|libro)s?([^a-z0-9]|$)'),
    ('ahorro', '(^|[^a-z0-9])(emergencia|inversion|ahorro|fondo)s?([^a-z0-9]|$)'),
    ('mascotas', '(^|[^a-z0-9])(peluqueria mascota|vacuna mascota|veterinario|mascota|perro|gato)s?([^a-z0-9]|$)'),
    ('compras', '(^|[^a-z0-9])(electronica|accesorios|zapatos|amazon|tienda|online|ropa)s?([^a-z0-9]|$)'),
    ('deporte', '(^|[^a-z0-9])(suplemento|gimnasio|proteina|cancha|yoga|gym)s?([^a-z0-9]|$)'),
    ('viajes', '(^|[^a-z0-9])(vacaciones|hospedaje|maleta|vuelo|hotel|paseo)s?([^a-z0-9]|$)')
), candidatos AS (
  SELECT DISTINCT ON (ie."id") ie."id" AS exp_id, bc."id" AS cat_id
  FROM "impulse_expenses" ie
  JOIN "budget_categories" bc ON bc."user_id" = ie."user_id"
  LEFT JOIN kw ON kw."cat" = translate(lower(btrim(bc."nombre")), 'áéíóúüñ', 'aeiouun')
  WHERE ie."budget_category_id" IS NULL
    AND (
      (kw."rx" IS NOT NULL AND translate(lower(ie."nombre"), 'áéíóúüñ', 'aeiouun') ~ kw."rx")
      -- búsqueda literal (sin regex): un nombre de categoría con "(" o "+" no rompe nada
      OR strpos(' ' || regexp_replace(translate(lower(ie."nombre"), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g') || ' ',
                ' ' || btrim(regexp_replace(translate(lower(bc."nombre"), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]+', ' ', 'g')) || ' ') > 0
    )
  ORDER BY ie."id", bc."nombre"
)
UPDATE "impulse_expenses" ie
SET "budget_category_id" = c.cat_id
FROM candidatos c
WHERE ie."id" = c.exp_id;

-- 4. Vínculo legacy categoría → gastos fijos (array linked_fixed_expense_ids)
--    pasa a la FK propia del gasto fijo, que es la que se usa de ahora en adelante.
UPDATE "fixed_expenses" f
SET "budget_category_id" = bc."id"
FROM "budget_categories" bc
WHERE f."id" = ANY(bc."linked_fixed_expense_ids")
  AND f."user_id" = bc."user_id"
  AND f."budget_category_id" IS NULL;
