-- Índices para las llaves foráneas y filtros más usados.
-- PostgreSQL no indexa solas las llaves foráneas: casi toda consulta de Kiri
-- filtra por user_id / debt_id y, sin índice, recorre la tabla completa. En la
-- prueba de carga (1.500 usuarios, ~350 mil filas) el Dashboard tardaba ~5 s
-- con 50 usuarios a la vez y borrar una cuenta revisaba cada tabla entera.

CREATE INDEX IF NOT EXISTS "debts_user_id_idx" ON "debts"("user_id");
CREATE INDEX IF NOT EXISTS "debts_co_owner_id_idx" ON "debts"("co_owner_id");
CREATE INDEX IF NOT EXISTS "debt_payments_debt_id_periodo_idx" ON "debt_payments"("debt_id", "periodo");
CREATE INDEX IF NOT EXISTS "debt_payments_tarjeta_id_idx" ON "debt_payments"("tarjeta_id");
CREATE INDEX IF NOT EXISTS "fixed_expenses_user_id_idx" ON "fixed_expenses"("user_id");
CREATE INDEX IF NOT EXISTS "savings_history_user_id_created_at_idx" ON "savings_history"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "extra_incomes_user_id_idx" ON "extra_incomes"("user_id");
CREATE INDEX IF NOT EXISTS "impulse_expenses_user_id_created_at_idx" ON "impulse_expenses"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "emergency_fund_history_user_id_idx" ON "emergency_fund_history"("user_id");
CREATE INDEX IF NOT EXISTS "income_records_user_id_created_at_idx" ON "income_records"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "savings_pockets_user_id_idx" ON "savings_pockets"("user_id");
CREATE INDEX IF NOT EXISTS "budget_categories_user_id_idx" ON "budget_categories"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");
CREATE INDEX IF NOT EXISTS "connections_addressee_id_idx" ON "connections"("addressee_id");
CREATE INDEX IF NOT EXISTS "loans_lender_id_idx" ON "loans"("lender_id");
CREATE INDEX IF NOT EXISTS "loans_borrower_id_idx" ON "loans"("borrower_id");
CREATE INDEX IF NOT EXISTS "loan_payments_loan_id_idx" ON "loan_payments"("loan_id");
CREATE INDEX IF NOT EXISTS "shared_deposits_shared_pocket_id_idx" ON "shared_deposits"("shared_pocket_id");
CREATE INDEX IF NOT EXISTS "shared_pocket_members_user_id_idx" ON "shared_pocket_members"("user_id");
CREATE INDEX IF NOT EXISTS "users_invited_by_id_idx" ON "users"("invited_by_id");
