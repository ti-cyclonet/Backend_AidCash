-- AlterTable: User — agregar dias_pago (array de enteros)
ALTER TABLE "users" ADD COLUMN "dias_pago" INTEGER[] DEFAULT '{}';

-- AlterTable: ExtraIncome — agregar fecha_recepcion
ALTER TABLE "extra_incomes" ADD COLUMN "fecha_recepcion" DATE;
