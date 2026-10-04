-- Cada categoría de presupuesto dice si su límite es del MES o de la QUINCENA.
-- Antes el límite siempre era mensual y, si el usuario cobraba quincenal, se
-- partía a la mitad: un mercado mensual hecho en una quincena salía "excedido".
ALTER TABLE "budget_categories" ADD COLUMN IF NOT EXISTS "frecuencia_limite" TEXT NOT NULL DEFAULT 'mensual';
