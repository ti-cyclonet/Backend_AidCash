-- Presupuesto del hogar: categorías compartidas en pareja
CREATE TABLE "shared_budget_categories" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "icono" TEXT NOT NULL DEFAULT '🏠',
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "monto_limite" DECIMAL(12,2) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shared_budget_categories_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shared_budget_categories_connection_id_idx" ON "shared_budget_categories"("connection_id");
ALTER TABLE "shared_budget_categories" ADD CONSTRAINT "shared_budget_categories_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "impulse_expenses" ADD COLUMN "shared_category_id" TEXT;
CREATE INDEX "impulse_expenses_shared_category_id_idx" ON "impulse_expenses"("shared_category_id");
ALTER TABLE "impulse_expenses" ADD CONSTRAINT "impulse_expenses_shared_category_id_fkey" FOREIGN KEY ("shared_category_id") REFERENCES "shared_budget_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
