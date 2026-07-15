-- AlterTable: fixed_expenses — agregar monto_pagado_este_periodo para pagos parciales
ALTER TABLE "fixed_expenses" ADD COLUMN "monto_pagado_este_periodo" DECIMAL(12,2);
