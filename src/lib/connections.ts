/**
 * Kiri Finance — Guard de conexión aceptada
 *
 * Extraído de shared-pockets.routes.ts / loans.routes.ts (estaba duplicado
 * idéntico en ambos). Cualquier ruta que exponga datos de OTRO usuario debe
 * pasar por acá primero — es el único portón de privacidad entre cuentas.
 */

import { prisma } from '../config/database.js'

export async function requireConnection(userAId: string, userBId: string): Promise<boolean> {
  const conn = await prisma.connection.findFirst({
    where: {
      status: 'ACCEPTED',
      OR: [
        { requesterId: userAId, addresseeId: userBId },
        { requesterId: userBId, addresseeId: userAId },
      ],
    },
  })
  return !!conn
}
