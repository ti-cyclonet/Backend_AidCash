-- CreateTable: bank_entities — Base de datos colaborativa de bancos
CREATE TABLE "bank_entities" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tasa_interes_promedio" DECIMAL(7,4) NOT NULL,
    "es_verificado" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_entities_nombre_key" ON "bank_entities"("nombre");

-- CreateTable: debt_payments — Historial de amortización
CREATE TABLE "debt_payments" (
    "id" TEXT NOT NULL,
    "debt_id" TEXT NOT NULL,
    "monto_pagado" DECIMAL(12,2) NOT NULL,
    "abono_capital" DECIMAL(12,2) NOT NULL,
    "pago_interes" DECIMAL(12,2) NOT NULL,
    "saldo_anterior" DECIMAL(12,2) NOT NULL,
    "saldo_posterior" DECIMAL(12,2) NOT NULL,
    "periodo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "debt_payments_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debt_id_fkey" FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: debts — nuevos campos de amortización y banco
ALTER TABLE "debts" ADD COLUMN "monto_inicial" DECIMAL(12,2);
ALTER TABLE "debts" ADD COLUMN "tasa_interes_aplicada" DECIMAL(7,4);
ALTER TABLE "debts" ADD COLUMN "fecha_inicio" DATE;
ALTER TABLE "debts" ADD COLUMN "bank_entity_id" TEXT;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_bank_entity_id_fkey" FOREIGN KEY ("bank_entity_id") REFERENCES "bank_entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: bancos colombianos comunes (verificados)
INSERT INTO "bank_entities" ("id", "nombre", "tasa_interes_promedio", "es_verificado", "created_at", "updated_at") VALUES
(gen_random_uuid(), 'Bancolombia', 1.8500, true, NOW(), NOW()),
(gen_random_uuid(), 'Davivienda', 1.9200, true, NOW(), NOW()),
(gen_random_uuid(), 'BBVA Colombia', 1.7800, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco de Bogotá', 1.8900, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco Popular', 2.0500, true, NOW(), NOW()),
(gen_random_uuid(), 'Scotiabank Colpatria', 1.9500, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco de Occidente', 1.8700, true, NOW(), NOW()),
(gen_random_uuid(), 'Nu Colombia', 2.8000, true, NOW(), NOW()),
(gen_random_uuid(), 'Rappi Pay', 2.5000, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco Falabella', 2.3500, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco Caja Social', 2.1000, true, NOW(), NOW()),
(gen_random_uuid(), 'Banco AV Villas', 1.9800, true, NOW(), NOW());
