-- Wallet: 4 bolsillos de saldo real
ALTER TABLE "users" ADD COLUMN "wallet_ahorro" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "wallet_obligaciones" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "wallet_libre" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "wallet_endeudamiento" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Registro de ingresos reales (flujo de caja)
CREATE TABLE "income_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "tipo" TEXT NOT NULL,
    "a_ahorro" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "a_obligaciones" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "a_libre" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "a_endeudamiento" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "income_records_pkey" PRIMARY KEY ("id")
);

-- FK
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
