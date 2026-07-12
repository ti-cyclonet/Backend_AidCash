import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'

const router = Router()
router.use(authMiddleware)

// ═══════════════════════════════════════════════════════════════════════════════
// POST /expenses/split — Dividir un gasto hormiga entre amigos
// ═══════════════════════════════════════════════════════════════════════════════
//
// Recibe el ID de un impulse_expense y un array de friendIds.
// Divide el monto equitativamente y genera un loan por cada amigo.
// El usuario que pagó se convierte en "lender" (prestamista) y cada amigo
// en "borrower" (deudor) por su porción.
//
// Ejemplo: Gasto de $30,000 dividido entre el usuario + 2 amigos
//   → Cada uno debe $10,000
//   → Se generan 2 loans de $10,000 (uno por amigo)

const splitSchema = z.object({
  expenseId: z.string().min(1),
  friendIds: z.array(z.string().min(1)).min(1).max(10),
})

router.post('/', validate(splitSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { expenseId, friendIds } = req.body as { expenseId: string; friendIds: string[] }

    // 1. Verificar que el gasto existe y pertenece al usuario
    const expense = await prisma.impulseExpense.findFirst({
      where: { id: expenseId, userId },
    })
    if (!expense) {
      res.status(404).json({ error: 'Gasto no encontrado' })
      return
    }

    // 2. Verificar que todos los amigos tienen conexión ACCEPTED
    const connections = await prisma.connection.findMany({
      where: {
        status: 'ACCEPTED',
        OR: friendIds.flatMap(fId => [
          { requesterId: userId, addresseeId: fId },
          { requesterId: fId, addresseeId: userId },
        ]),
      },
    })

    // Extraer IDs de usuarios realmente conectados
    const connectedIds = new Set<string>()
    connections.forEach(c => {
      if (c.requesterId === userId) connectedIds.add(c.addresseeId)
      else connectedIds.add(c.requesterId)
    })

    const invalidFriends = friendIds.filter(id => !connectedIds.has(id))
    if (invalidFriends.length > 0) {
      res.status(403).json({ error: `No estás conectado con todos los usuarios`, invalidFriends })
      return
    }

    // 3. Calcular monto por persona (gasto / (usuario + N amigos))
    const totalPeople = friendIds.length + 1 // incluye al que pagó
    const montoTotal = Number(expense.monto)
    const montoPorPersona = Math.round(montoTotal / totalPeople)

    // 4. Obtener nombre del usuario para las notificaciones
    const lender = await prisma.user.findUnique({
      where: { id: userId },
      select: { nombre: true },
    })

    // 5. Crear un loan por cada amigo
    const loans = await prisma.$transaction(
      friendIds.map(friendId =>
        prisma.loan.create({
          data: {
            lenderId: userId,
            borrowerId: friendId,
            amount: montoPorPersona,
            remainingAmount: montoPorPersona,
            descripcion: `Split: ${expense.nombre} (${totalPeople} personas)`,
            status: 'ACTIVE', // Se activa directo (el gasto ya ocurrió)
            sourceExpenseId: expenseId,
          },
        })
      )
    )

    // 6. Notificar a cada amigo
    for (const loan of loans) {
      emitToUser(loan.borrowerId, SOCKET_EVENTS.LOAN_REQUESTED, {
        loanId: loan.id,
        amount: montoPorPersona,
        descripcion: `Split: ${expense.nombre}`,
        borrower: { id: userId, nombre: lender?.nombre },
        isSplit: true,
      })
    }

    res.status(201).json({
      split: {
        expenseId,
        expenseName: expense.nombre,
        montoTotal,
        totalPeople,
        montoPorPersona,
        loans: loans.map(l => ({
          id: l.id,
          borrowerId: l.borrowerId,
          amount: Number(l.amount),
        })),
      },
    })
  } catch (error) {
    console.error('[ExpenseSplit]', error)
    res.status(500).json({ error: 'Error al dividir el gasto' })
  }
})

export default router
