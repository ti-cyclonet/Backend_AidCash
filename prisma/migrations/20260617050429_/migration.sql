-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "correo" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "ingreso_base" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "frecuencia_ingreso" TEXT NOT NULL DEFAULT 'mensual',
    "onboarding_done" BOOLEAN NOT NULL DEFAULT false,
    "meta_ahorro_global" DECIMAL(12,2) NOT NULL DEFAULT 5000,
    "saldo_ahorro_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fondo_emergencia_actual" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "streak_actual" INTEGER NOT NULL DEFAULT 0,
    "streak_mejor" INTEGER NOT NULL DEFAULT 0,
    "streak_ultimo_check" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "monto_total" DECIMAL(12,2) NOT NULL,
    "cuota_periodo" DECIMAL(12,2) NOT NULL,
    "fecha_vencimiento" TEXT NOT NULL,
    "pagado_este_periodo" BOOLEAN NOT NULL DEFAULT false,
    "estado" TEXT NOT NULL DEFAULT 'activa',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_expenses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "fecha_corte" TEXT NOT NULL,
    "pagado_este_periodo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "tipo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extra_incomes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "temporalidad" TEXT NOT NULL,
    "meses_restantes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extra_incomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impulse_expenses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "categoria" TEXT NOT NULL DEFAULT 'otro',
    "periodo" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impulse_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_fund_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "tipo" TEXT NOT NULL,
    "nota" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_fund_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "badge_id" TEXT NOT NULL,
    "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_correo_key" ON "users"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "impulse_expenses_user_id_periodo_idx" ON "impulse_expenses"("user_id", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "user_badges_user_id_badge_id_key" ON "user_badges"("user_id", "badge_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_expenses" ADD CONSTRAINT "fixed_expenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "savings_history" ADD CONSTRAINT "savings_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extra_incomes" ADD CONSTRAINT "extra_incomes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impulse_expenses" ADD CONSTRAINT "impulse_expenses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_fund_history" ADD CONSTRAINT "emergency_fund_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
