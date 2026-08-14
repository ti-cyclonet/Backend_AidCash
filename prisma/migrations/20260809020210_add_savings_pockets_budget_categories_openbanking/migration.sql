-- AlterTable
ALTER TABLE "bank_entities" ADD COLUMN     "api_provider" TEXT,
ADD COLUMN     "provider_item_id" TEXT;

-- CreateTable
CREATE TABLE "savings_pockets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "meta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monto_actual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#10B981',
    "icono" TEXT NOT NULL DEFAULT 'piggy-bank',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "savings_pockets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_categories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "icono" TEXT NOT NULL DEFAULT 'tag',
    "color" TEXT NOT NULL DEFAULT '#6366F1',
    "tipo" TEXT NOT NULL DEFAULT 'gasto',

    CONSTRAINT "budget_categories_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "savings_pockets" ADD CONSTRAINT "savings_pockets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
