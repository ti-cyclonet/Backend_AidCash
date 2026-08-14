-- CreateTable
CREATE TABLE "belvo_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "institution_type" TEXT NOT NULL DEFAULT 'bank',
    "access_mode" TEXT NOT NULL DEFAULT 'recurrent',
    "status" TEXT NOT NULL DEFAULT 'valid',
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "belvo_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "belvo_accounts" (
    "id" TEXT NOT NULL,
    "belvo_link_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "numero" TEXT,
    "moneda" TEXT NOT NULL DEFAULT 'COP',
    "balance_actual" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_disponible" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "belvo_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "belvo_transactions" (
    "id" TEXT NOT NULL,
    "belvo_link_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "tipo" TEXT NOT NULL,
    "categoria" TEXT,
    "descripcion" TEXT,
    "comercio" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "belvo_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "belvo_links_link_id_key" ON "belvo_links"("link_id");

-- CreateIndex
CREATE UNIQUE INDEX "belvo_accounts_account_id_key" ON "belvo_accounts"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "belvo_transactions_transaction_id_key" ON "belvo_transactions"("transaction_id");

-- CreateIndex
CREATE INDEX "belvo_transactions_belvo_link_id_fecha_idx" ON "belvo_transactions"("belvo_link_id", "fecha");

-- AddForeignKey
ALTER TABLE "belvo_links" ADD CONSTRAINT "belvo_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "belvo_accounts" ADD CONSTRAINT "belvo_accounts_belvo_link_id_fkey" FOREIGN KEY ("belvo_link_id") REFERENCES "belvo_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "belvo_transactions" ADD CONSTRAINT "belvo_transactions_belvo_link_id_fkey" FOREIGN KEY ("belvo_link_id") REFERENCES "belvo_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
