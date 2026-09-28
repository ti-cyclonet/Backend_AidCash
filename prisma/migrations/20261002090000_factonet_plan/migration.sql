-- Mi plan + FactoNet: última factura pendiente que avisó Authoriza y el cambio de plan solicitado desde Kiri
ALTER TABLE "users" ADD COLUMN "factura_pendiente" JSONB;
ALTER TABLE "users" ADD COLUMN "cambio_plan" JSONB;
