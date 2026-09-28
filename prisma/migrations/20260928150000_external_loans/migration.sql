-- "Me deben": préstamos a personas que no usan Kiri.
CREATE TABLE "external_loans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "telefono" TEXT,
    "monto_prestado" DECIMAL(12,2) NOT NULL,
    "saldo_pendiente" DECIMAL(12,2) NOT NULL,
    "monto_desde_billetera" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fecha_prestamo" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_compromiso" DATE,
    "nota" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'activo',
    "cerrado_en" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_loans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_loan_payments" (
    "id" TEXT NOT NULL,
    "loan_id" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "entra_a_billetera" BOOLEAN NOT NULL DEFAULT true,
    "nota" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_loan_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "external_loans_user_id_estado_idx" ON "external_loans"("user_id", "estado");
CREATE INDEX "external_loan_payments_loan_id_idx" ON "external_loan_payments"("loan_id");

ALTER TABLE "external_loans" ADD CONSTRAINT "external_loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_loan_payments" ADD CONSTRAINT "external_loan_payments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "external_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
