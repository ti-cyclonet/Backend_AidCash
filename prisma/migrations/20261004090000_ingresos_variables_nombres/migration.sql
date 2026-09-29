-- Partes del nombre y formas de recibir ingresos (fijo igual, fijo por quincena, variable)
ALTER TABLE "users" ADD COLUMN "primer_nombre" TEXT;
ALTER TABLE "users" ADD COLUMN "segundo_nombre" TEXT;
ALTER TABLE "users" ADD COLUMN "primer_apellido" TEXT;
ALTER TABLE "users" ADD COLUMN "segundo_apellido" TEXT;
ALTER TABLE "users" ADD COLUMN "tipo_ingreso" TEXT NOT NULL DEFAULT 'fijo';
ALTER TABLE "users" ADD COLUMN "ingreso_quincena1" DECIMAL(12,2);
ALTER TABLE "users" ADD COLUMN "ingreso_quincena2" DECIMAL(12,2);
