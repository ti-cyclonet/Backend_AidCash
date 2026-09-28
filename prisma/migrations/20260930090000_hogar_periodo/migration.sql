-- Presupuesto del hogar: periodo del tope (mensual | quincenal), lo cambia cualquiera de los dos
ALTER TABLE "connections" ADD COLUMN "hogar_periodo" TEXT NOT NULL DEFAULT 'mensual';
