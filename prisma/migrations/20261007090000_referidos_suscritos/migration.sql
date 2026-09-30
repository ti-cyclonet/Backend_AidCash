-- Nuevo esquema de invitaciones: el amigo invitado tiene 50% en su primer mes
-- de KIRI PLUS (30% en PRO) y quien invitó gana 10 días de PLUS cuando ese
-- amigo paga su primera factura (hasta 3 amigos).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "primer_pago_en" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "descuento_referido_usado" BOOLEAN NOT NULL DEFAULT false;
