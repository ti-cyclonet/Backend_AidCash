-- Plan comprado dentro de la app (App Store / Google Play vía RevenueCat)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_tienda" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_tienda_hasta" TIMESTAMP(3);
