-- Tienda v2: cofres regalados entre amigos y nuevos accesorios (formas en vez de colores)
ALTER TABLE "user_chests" ADD COLUMN IF NOT EXISTS "regalado_por" TEXT;
DO $$ BEGIN
  ALTER TABLE "user_chests" ADD CONSTRAINT "user_chests_regalado_por_fkey" FOREIGN KEY ("regalado_por") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lo comprado del catálogo viejo pasa al artículo nuevo más parecido (sin duplicar si ya lo tenía)
CREATE TEMP TABLE _kiri_mapa (tipo TEXT, viejo TEXT, nuevo TEXT);
INSERT INTO _kiri_mapa VALUES
  ('cerca', 'azul', 'reja'), ('cerca', 'rosa', 'seto'),
  ('regadera', 'roja', 'balde'), ('regadera', 'verde', 'vaso'), ('regadera', 'rosa', 'vaso'), ('regadera', 'cobre', 'pistola'),
  ('frutos', 'naranja', 'calabaza'), ('frutos', 'durazno', 'dulces'), ('frutos', 'limon', 'estrella'), ('frutos', 'ciruela', 'balon'), ('frutos', 'dorada', 'moneda');

UPDATE "user_cosmetics" c SET "clave" = m.nuevo
FROM _kiri_mapa m
WHERE c."tipo" = m.tipo AND c."clave" = m.viejo
  AND NOT EXISTS (SELECT 1 FROM "user_cosmetics" o WHERE o."user_id" = c."user_id" AND o."tipo" = m.tipo AND o."clave" = m.nuevo);
DELETE FROM "user_cosmetics" c USING _kiri_mapa m WHERE c."tipo" = m.tipo AND c."clave" = m.viejo;

-- Lo que tenían puesto (cerca; un UPDATE por tipo: cada fila solo toma una coincidencia)
UPDATE "users" u SET "jardin_equipado" = jsonb_set(u."jardin_equipado"::jsonb, ARRAY['cerca'], to_jsonb(m.nuevo))
FROM _kiri_mapa m
WHERE m.tipo = 'cerca' AND u."jardin_equipado" IS NOT NULL AND u."jardin_equipado"::jsonb ->> 'cerca' = m.viejo;
-- Lo que tenían puesto (regadera; un UPDATE por tipo: cada fila solo toma una coincidencia)
UPDATE "users" u SET "jardin_equipado" = jsonb_set(u."jardin_equipado"::jsonb, ARRAY['regadera'], to_jsonb(m.nuevo))
FROM _kiri_mapa m
WHERE m.tipo = 'regadera' AND u."jardin_equipado" IS NOT NULL AND u."jardin_equipado"::jsonb ->> 'regadera' = m.viejo;
-- Lo que tenían puesto (frutos; un UPDATE por tipo: cada fila solo toma una coincidencia)
UPDATE "users" u SET "jardin_equipado" = jsonb_set(u."jardin_equipado"::jsonb, ARRAY['frutos'], to_jsonb(m.nuevo))
FROM _kiri_mapa m
WHERE m.tipo = 'frutos' AND u."jardin_equipado" IS NOT NULL AND u."jardin_equipado"::jsonb ->> 'frutos' = m.viejo;

DROP TABLE _kiri_mapa;
