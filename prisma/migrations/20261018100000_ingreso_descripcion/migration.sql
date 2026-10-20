-- Ingreso extra con descripción ("Freelance", "venta del celular"…): antes el
-- formulario la pedía pero no se guardaba y en Balance solo salía "Ingreso extra".
ALTER TABLE "income_records" ADD COLUMN IF NOT EXISTS "descripcion" TEXT;
