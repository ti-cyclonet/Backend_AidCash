import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'
import { pushLoanPayment } from '../lib/push.js'
import { checkLimit } from '../middleware/limit-enforcement.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const requestLoanSchema = z.object({
  lenderId:    z.string().min(1),
  amount:      z.number().min(0.01),
  descripcion: z.string().optional(),
  dueDate:     z.string().optional(),
})

const respondLoanSchema = z.object({
  loanId: z.string().min(1),
})

const paymentSchema = z.object({
  loanId: z.string().min(1),
  monto:  z.number().min(0.01),
  nota:   z.string().optional(),
})

const confirmPaymentSchema = z.object({
  paymentId: z.string().min(1),
})

// ─── Helper: verificar conexión aceptada ──────────────────────────────────────

async function requireConnection(userAId: string, userBId: string): Promise<boolean> {
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

// ─── GET /loans ───────────────────────────────────────────────────────────────
// Devuelve préstamos donde el usuario es prestamista o prestatario
// Auto-elimina préstamos pagados con más de 3 días (limpieza lazy)

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    // Auto-cleanup: eliminar préstamos pagados hace más de 3 días
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await prisma.loan.deleteMany({
      where: {
        status: 'PAID',
        updatedAt: { lt: threeDaysAgo },
        OR: [{ lenderId: userId }, { borrowerId: userId }],
      },
    })

    const loans = await prisma.loan.findMany({
      where: { OR: [{ lenderId: userId }, { borrowerId: userId }] },
      include: {
        lender:   { select: { id: true, nombre: true, correo: true } },
        borrower: { select: { id: true, nombre: true, correo: true } },
        payments: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      loans: loans.map(l => ({
        ...l,
        amount:          Number(l.amount),
        remainingAmount: Number(l.remainingAmount),
        payments: l.payments.map(p => ({ ...p, monto: Number(p.monto) })),
      })),
    })
  } catch (error) {
    console.error('[GetLoans]', error)
    res.status(500).json({ error: 'Error al obtener préstamos' })
  }
})

// ─── POST /loans/request ──────────────────────────────────────────────────────
// Borrower solicita préstamo a Lender

router.post('/request', validate(requestLoanSchema), checkLimit('nPrestamos'), async (req: Request, res: Response): Promise<void> => {
  try {
    const borrowerId = req.user!.userId
    const { lenderId, amount, descripcion, dueDate } = req.body as {
      lenderId: string; amount: number; descripcion?: string; dueDate?: string
    }

    if (borrowerId === lenderId) {
      res.status(400).json({ error: 'No puedes solicitarte un préstamo a ti mismo' })
      return
    }

    const connected = await requireConnection(borrowerId, lenderId)
    if (!connected) {
      res.status(403).json({ error: 'Solo puedes solicitar préstamos a usuarios conectados' })
      return
    }

    const borrower = await prisma.user.findUnique({
      where: { id: borrowerId },
      select: { nombre: true, correo: true },
    })

    const loan = await prisma.loan.create({
      data: {
        lenderId,
        borrowerId,
        amount,
        remainingAmount: amount,
        descripcion,
        dueDate,
        status: 'PENDING_APPROVAL',
      },
    })

    // Notificar al prestamista
    emitToUser(lenderId, SOCKET_EVENTS.LOAN_REQUESTED, {
      loanId:    loan.id,
      amount,
      descripcion,
      dueDate,
      borrower: { id: borrowerId, ...borrower },
    })

    res.status(201).json({ loan: { ...loan, amount: Number(loan.amount), remainingAmount: Number(loan.remainingAmount) } })
  } catch (error) {
    console.error('[RequestLoan]', error)
    res.status(500).json({ error: 'Error al solicitar préstamo' })
  }
})

// ─── POST /loans/approve ──────────────────────────────────────────────────────
// Lender aprueba la solicitud

// ─── POST /loans/approve — Lender aprueba CON interés (negociación) ────────────
// El lender selecciona una tasa de interés (0%, 5%, 10%, etc.)
// Se calcula el nuevo remainingAmount = amount + (amount * tasa / 100)
// El préstamo pasa a PENDING_BORROWER_CONFIRMATION
// Se emite evento socket al borrower con la contraoferta

const approveWithInterestSchema = z.object({
  loanId: z.string().min(1),
  tasaInteres: z.number().min(0).max(100).optional(),
})

router.post('/approve', validate(approveWithInterestSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const lenderId = req.user!.userId
    const { loanId, tasaInteres = 0 } = req.body as { loanId: string; tasaInteres?: number }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, lenderId, status: 'PENDING_APPROVAL' },
      include: { borrower: { select: { id: true, nombre: true } } },
    })
    if (!loan) {
      res.status(404).json({ error: 'Préstamo no encontrado o ya procesado' })
      return
    }

    const lender = await prisma.user.findUnique({ where: { id: lenderId }, select: { cashBalance: true, nombre: true } })
    const lenderBalance = Number(lender?.cashBalance ?? 0)
    const montoOriginal = Number(loan.amount)

    if (lenderBalance < montoOriginal) {
      res.status(400).json({ error: 'No tienes saldo suficiente', disponible: lenderBalance, requerido: montoOriginal })
      return
    }

    // Calcular monto con interés
    const interes = Math.round(montoOriginal * (tasaInteres / 100))
    const montoConInteres = montoOriginal + interes

    if (tasaInteres > 0) {
      // ═══ CON INTERÉS: Pasa a estado intermedio para que el borrower confirme ═══
      const updated = await prisma.loan.update({
        where: { id: loanId },
        data: {
          status: 'PENDING_BORROWER_CONFIRMATION',
          remainingAmount: montoConInteres,
          amount: montoConInteres,
        },
      })

      // Guardar campos de interés con raw query
      try {
        await prisma.$executeRaw`UPDATE loans SET tasa_interes = ${tasaInteres}, monto_original = ${montoOriginal} WHERE id = ${loanId}`
      } catch { /* silent */ }

      // Notificar al borrower con la contraoferta
      emitToUser(loan.borrowerId, SOCKET_EVENTS.LOAN_APPROVED, {
        loanId,
        amount: montoConInteres,
        montoOriginal,
        tasaInteres,
        interes,
        requiresConfirmation: true,
        lenderName: lender?.nombre,
      })

      res.json({
        loan: { ...updated, amount: Number(updated.amount), remainingAmount: Number(updated.remainingAmount) },
        requiresConfirmation: true,
        tasaInteres,
        interes,
        montoConInteres,
      })
    } else {
      // ═══ SIN INTERÉS: Aprobación directa (flujo original) ═══
      const [updated] = await prisma.$transaction([
        prisma.loan.update({
          where: { id: loanId },
          data: { status: 'ACTIVE' },
        }),
        prisma.user.update({
          where: { id: lenderId },
          data: { cashBalance: { decrement: montoOriginal } },
        }),
      ])

      // Guardar campos de interés con raw query (workaround si prisma client no está regenerado)
      try {
        await prisma.$executeRaw`UPDATE loans SET tasa_interes = 0, monto_original = ${montoOriginal} WHERE id = ${loanId}`
      } catch { /* silent — columnas pueden no existir */ }

      emitToUser(loan.borrowerId, SOCKET_EVENTS.LOAN_APPROVED, {
        loanId, amount: montoOriginal, tasaInteres: 0, requiresConfirmation: false,
      })

      res.json({ loan: { ...updated, amount: Number(updated.amount), remainingAmount: Number(updated.remainingAmount) }, requiresConfirmation: false })
    }
  } catch (error) {
    console.error('[ApproveLoan]', error)
    res.status(500).json({ error: 'Error al aprobar préstamo' })
  }
})

// ─── POST /loans/borrower-confirm — Borrower acepta la contraoferta con interés ─

const borrowerConfirmSchema = z.object({
  loanId: z.string().min(1),
  accept: z.boolean(),
})

router.post('/borrower-confirm', validate(borrowerConfirmSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const borrowerId = req.user!.userId
    const { loanId, accept } = req.body as { loanId: string; accept: boolean }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, borrowerId, status: 'PENDING_BORROWER_CONFIRMATION' },
    })
    if (!loan) {
      res.status(404).json({ error: 'Préstamo no encontrado o ya procesado' })
      return
    }

    if (accept) {
      // Borrower acepta → Activar préstamo y descontar del lender
      const [updated] = await prisma.$transaction([
        prisma.loan.update({ where: { id: loanId }, data: { status: 'ACTIVE' } }),
        prisma.user.update({
          where: { id: loan.lenderId },
          data: { cashBalance: { decrement: Number(loan.montoOriginal ?? loan.amount) } },
        }),
      ])

      emitToUser(loan.lenderId, SOCKET_EVENTS.LOAN_APPROVED, {
        loanId, borrowerAccepted: true, amount: Number(updated.amount),
      })

      res.json({ loan: { ...updated, amount: Number(updated.amount), remainingAmount: Number(updated.remainingAmount) }, accepted: true })
    } else {
      // Borrower rechaza → Volver a PENDING_APPROVAL (sin interés)
      const updated = await prisma.loan.update({
        where: { id: loanId },
        data: {
          status: 'REJECTED',
          tasaInteres: null,
          amount: loan.montoOriginal ?? loan.amount,
          remainingAmount: loan.montoOriginal ?? loan.amount,
        },
      })

      emitToUser(loan.lenderId, SOCKET_EVENTS.LOAN_REJECTED, { loanId, borrowerRejected: true })

      res.json({ loan: { ...updated, amount: Number(updated.amount), remainingAmount: Number(updated.remainingAmount) }, accepted: false })
    }
  } catch (error) {
    console.error('[BorrowerConfirm]', error)
    res.status(500).json({ error: 'Error al confirmar préstamo' })
  }
})

// ─── POST /loans/reject ───────────────────────────────────────────────────────

router.post('/reject', validate(respondLoanSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const lenderId = req.user!.userId
    const { loanId } = req.body as { loanId: string }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, lenderId, status: 'PENDING_APPROVAL' },
    })
    if (!loan) {
      res.status(404).json({ error: 'Préstamo no encontrado o ya procesado' })
      return
    }

    const updated = await prisma.loan.update({
      where: { id: loanId },
      data: { status: 'REJECTED' },
    })

    emitToUser(loan.borrowerId, SOCKET_EVENTS.LOAN_REJECTED, { loanId })

    res.json({ loan: { ...updated, amount: Number(updated.amount), remainingAmount: Number(updated.remainingAmount) } })
  } catch (error) {
    console.error('[RejectLoan]', error)
    res.status(500).json({ error: 'Error al rechazar préstamo' })
  }
})

// ─── POST /loans/cancel — Borrower cancela su propia solicitud pendiente ──────

router.post('/cancel', validate(respondLoanSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const borrowerId = req.user!.userId
    const { loanId } = req.body as { loanId: string }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, borrowerId, status: 'PENDING_APPROVAL' },
    })
    if (!loan) {
      res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' })
      return
    }

    // Eliminar directamente (ya no tiene sentido mantenerla)
    await prisma.loan.delete({ where: { id: loanId } })

    res.json({ message: 'Solicitud cancelada' })
  } catch (error) {
    console.error('[CancelLoan]', error)
    res.status(500).json({ error: 'Error al cancelar solicitud' })
  }
})

// ─── POST /loans/payment ──────────────────────────────────────────────────────
// Borrower registra un abono
// Si la conexión es de tipo PARTNER, se auto-confirma (sin paso de pending)

router.post('/payment', validate(paymentSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const borrowerId = req.user!.userId
    const { loanId, monto, nota } = req.body as { loanId: string; monto: number; nota?: string }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, borrowerId, status: 'ACTIVE' },
      include: { lender: { select: { id: true, nombre: true } } },
    })
    if (!loan) {
      res.status(404).json({ error: 'Préstamo activo no encontrado' })
      return
    }

    if (monto > Number(loan.remainingAmount)) {
      res.status(400).json({ error: `El abono (${monto}) supera el saldo pendiente (${loan.remainingAmount})` })
      return
    }

    // Verificar si son PARTNER — auto-confirmar si lo son
    const partnerConnection = await prisma.connection.findFirst({
      where: {
        status: 'ACCEPTED',
        role: 'PARTNER',
        OR: [
          { requesterId: borrowerId, addresseeId: loan.lenderId },
          { requesterId: loan.lenderId, addresseeId: borrowerId },
        ],
      },
    })

    const isPartner = !!partnerConnection
    const paymentStatus = isPartner ? 'CONFIRMED' : 'PENDING_CONFIRMATION'

    const borrower = await prisma.user.findUnique({
      where: { id: borrowerId },
      select: { nombre: true },
    })

    if (isPartner) {
      // Auto-confirmar: crear pago + descontar del remaining en una transacción
      const newRemaining = Number(loan.remainingAmount) - monto
      const newLoanStatus = newRemaining <= 0 ? 'PAID' : 'ACTIVE'

      const [payment, updatedLoan] = await prisma.$transaction([
        prisma.loanPayment.create({
          data: { loanId, userId: borrowerId, monto, nota, status: 'CONFIRMED' },
        }),
        prisma.loan.update({
          where: { id: loanId },
          data: { remainingAmount: Math.max(0, newRemaining), status: newLoanStatus },
        }),
      ])

      // Notificar al prestamista (ya confirmado)
      emitToUser(loan.lenderId, SOCKET_EVENTS.LOAN_PAYMENT_CONFIRMED, {
        paymentId: payment.id,
        loanId,
        monto,
        remainingAmount: Number(updatedLoan.remainingAmount),
        loanStatus: newLoanStatus,
        autoConfirmed: true,
        borrower: { id: borrowerId, nombre: borrower?.nombre },
      })

      res.status(201).json({
        payment: { ...payment, monto: Number(payment.monto) },
        autoConfirmed: true,
        loan: { ...updatedLoan, amount: Number(updatedLoan.amount), remainingAmount: Number(updatedLoan.remainingAmount) },
      })
    } else {
      // Flujo normal: queda en PENDING_CONFIRMATION
      const payment = await prisma.loanPayment.create({
        data: { loanId, userId: borrowerId, monto, nota, status: 'PENDING_CONFIRMATION' },
      })

      emitToUser(loan.lenderId, SOCKET_EVENTS.LOAN_PAYMENT, {
        paymentId: payment.id,
        loanId,
        monto,
        nota,
        borrower: { id: borrowerId, nombre: borrower?.nombre },
        remainingAmount: Number(loan.remainingAmount),
      })

      // Push notification al prestamista
      pushLoanPayment(loan.lenderId, borrower?.nombre ?? 'Alguien', monto)

      res.status(201).json({ payment: { ...payment, monto: Number(payment.monto) }, autoConfirmed: false })
    }
  } catch (error) {
    console.error('[LoanPayment]', error)
    res.status(500).json({ error: 'Error al registrar abono' })
  }
})

// ─── POST /loans/payment/confirm ─────────────────────────────────────────────
// Lender confirma el abono → se descuenta del remainingAmount

router.post('/payment/confirm', validate(confirmPaymentSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const lenderId = req.user!.userId
    const { paymentId } = req.body as { paymentId: string }

    const payment = await prisma.loanPayment.findFirst({
      where: { id: paymentId, status: 'PENDING_CONFIRMATION' },
      include: {
        loan: true,
      },
    })
    if (!payment) {
      res.status(404).json({ error: 'Pago no encontrado o ya procesado' })
      return
    }
    if (payment.loan.lenderId !== lenderId) {
      res.status(403).json({ error: 'No autorizado' })
      return
    }

    const newRemaining = Number(payment.loan.remainingAmount) - Number(payment.monto)
    const newLoanStatus = newRemaining <= 0 ? 'PAID' : 'ACTIVE'

    const [confirmedPayment, updatedLoan] = await prisma.$transaction([
      prisma.loanPayment.update({
        where: { id: paymentId },
        data: { status: 'CONFIRMED' },
      }),
      prisma.loan.update({
        where: { id: payment.loanId },
        data: {
          remainingAmount: Math.max(0, newRemaining),
          status: newLoanStatus,
        },
      }),
    ])

    emitToUser(payment.userId, SOCKET_EVENTS.LOAN_PAYMENT_CONFIRMED, {
      paymentId,
      loanId:          payment.loanId,
      monto:           Number(payment.monto),
      remainingAmount: Number(updatedLoan.remainingAmount),
      loanStatus:      newLoanStatus,
    })

    res.json({
      payment:         { ...confirmedPayment, monto: Number(confirmedPayment.monto) },
      loan:            { ...updatedLoan, amount: Number(updatedLoan.amount), remainingAmount: Number(updatedLoan.remainingAmount) },
    })
  } catch (error) {
    console.error('[ConfirmPayment]', error)
    res.status(500).json({ error: 'Error al confirmar pago' })
  }
})

// ─── POST /loans/payment/reject ───────────────────────────────────────────────
// Lender rechaza el abono (ej: no llegó el dinero)

router.post('/payment/reject', validate(confirmPaymentSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const lenderId = req.user!.userId
    const { paymentId } = req.body as { paymentId: string }

    const payment = await prisma.loanPayment.findFirst({
      where: { id: paymentId, status: 'PENDING_CONFIRMATION' },
      include: { loan: true },
    })
    if (!payment || payment.loan.lenderId !== lenderId) {
      res.status(404).json({ error: 'Pago no encontrado o no autorizado' })
      return
    }

    const rejected = await prisma.loanPayment.update({
      where: { id: paymentId },
      data: { status: 'REJECTED' },
    })

    emitToUser(payment.userId, SOCKET_EVENTS.LOAN_PAYMENT_REJECTED, {
      paymentId,
      loanId: payment.loanId,
    })

    res.json({ payment: { ...rejected, monto: Number(rejected.monto) } })
  } catch (error) {
    console.error('[RejectPayment]', error)
    res.status(500).json({ error: 'Error al rechazar pago' })
  }
})

export default router
