-- % de descuento de invitado que se pidió para la primera factura (Mi plan lo
-- muestra solo durante ese primer mes; después se cobra el precio normal).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "descuento_primer_mes" INTEGER;
