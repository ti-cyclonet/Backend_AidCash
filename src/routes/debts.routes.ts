import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { sendPushToUser } from '../lib/push.js'
import { checkLimit, attachUsageWarning } from '../middleware/limit-enforcement.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createDebtSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  montoTotal: z.number().min(0.01),
  cuotaPeriodo: z.number().min(0.01),
  acreedor: z.string().default(''),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).default('mensual'),
  diasPago: z.string().default('1'), // "15" o "15,30"
  tasaInteres: z.number().min(0).optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).default('media'),
})

const updateDebtSchema = z.object({
  nombre: z.string().min(1).optional(),
  montoTotal: z.number().min(0).optional(),
  saldoRestante: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0).optional(),
  acreedor: z.string().optional(),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).optional(),
  diasPago: z.string().optional(),
  tasaInteres: z.number().min(0).nullable().optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).optional(),
  pagadoEstePeriodo: z.boolean().optional(),
  estado: z.enum(['activa', 'saldada', 'vencida']).optional(),
  pagoAutomatico: z.boolean().optional(),
}).strict()

const payDebtSchema = z.object({
  monto: z.number().min(0.01).optional(), // Si no se envía, usa cuotaPeriodo
})

// ─── GET /debts ───────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const estado = (req.query.estado as string) || 'activa'

    const debts = await prisma.debt.findMany({
      where: { userId, estado },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      debts: debts.map(d => ({
        ...d,
        montoTotal: Number(d.montoTotal),
        saldoRestante: Number(d.saldoRestante),
        cuotaPeriodo: Number(d.cuotaPeriodo),
        tasaInteres: d.tasaInteres ? Number(d.tasaInteres) : null,
      })),
    })
  } catch (error) {
    console.error('[GetDebts]', error)
    res.status(500).json({ error: 'Error al obtener deudas' })
  }
})

// ─── POST /debts ──────────────────────────────────────────────────────────────

router.post('/', validate(createDebtSchema), checkLimit('nDeudas'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, montoTotal, saldoRestante, cuotaPeriodo, acreedor, frecuenciaPago, diasPago, tasaInteres, prioridad } = req.body

    const debt = await prisma.debt.create({
      data: {
        userId,
        nombre,
        montoTotal,
        // Si el usuario ingresó un saldo actual diferente (ya venía pagando), usarlo
        saldoRestante: saldoRestante ?? montoTotal,
        montoInicial: montoTotal,
        cuotaPeriodo,
        acreedor: acreedor || '',
        frecuenciaPago: frecuenciaPago || 'mensual',
        diasPago: diasPago || '1',
        tasaInteres: tasaInteres ?? null,
        tasaInteresAplicada: tasaInteres ?? null,
        prioridad: prioridad || 'media',
        pagadoEstePeriodo: false,
        estado: 'activa',
        fechaInicio: new Date(),
      },
    })

    res.status(201).json({
      debt: { ...debt, montoTotal: Number(debt.montoTotal), saldoRestante: Number(debt.saldoRestante), cuotaPeriodo: Number(debt.cuotaPeriodo), tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null },
    })
  } catch (error) {
    console.error('[CreateDebt]', error)
    res.status(500).json({ error: 'Error al crear deuda' })
  }
})

// ─── POST /debts/:id/pay ──────────────────────────────────────────────────────
// Registra un pago de cuota con cálculo de amortización.
// Si la deuda tiene tasa de interés, divide el pago en interés + abono a capital.
// Solo el abono a capital reduce el saldoRestante.
// Registra el historial en debt_payments.

router.post('/:id/pay', validate(payDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId, estado: 'activa' } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda activa no encontrada' })
      return
    }

    const montoPago = req.body.monto ?? Number(existing.cuotaPeriodo)
    const currentSaldo = Number(existing.saldoRestante)

    // Obtener la tasa de interés aplicada (prioridad: tasaInteresAplicada > tasaInteres)
    const tasaMensual = existing.tasaInteresAplicada
      ? Number(existing.tasaInteresAplicada)
      : existing.tasaInteres
        ? Number(existing.tasaInteres)
        : null

    // Calcular amortización
    const { calcularAmortizacion } = await import('../lib/amortization.js')
    const amort = calcularAmortizacion(currentSaldo, tasaMensual, montoPago)

    const nuevoSaldo = amort.saldoPosterior
    const nuevoEstado = nuevoSaldo <= 0 ? 'saldada' : 'activa'

    // Periodo actual (para historial)
    const now = new Date()
    const periodo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    // Transacción: actualizar deuda + registrar historial de pago
    const [debt, payment] = await prisma.$transaction([
      prisma.debt.update({
        where: { id },
        data: {
          saldoRestante: nuevoSaldo,
          pagadoEstePeriodo: true,
          montoPagadoEstePeriodo: montoPago,
          estado: nuevoEstado,
        },
      }),
      prisma.debtPayment.create({
        data: {
          debtId: id,
          montoPagado: montoPago,
          abonoCapital: amort.abonoCapital,
          pagoInteres: amort.pagoInteres,
          saldoAnterior: amort.saldoAnterior,
          saldoPosterior: amort.saldoPosterior,
          periodo,
        },
      }),
    ])

    res.json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        montoPagadoEstePeriodo: debt.montoPagadoEstePeriodo ? Number(debt.montoPagadoEstePeriodo) : null,
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
      },
      amortizacion: {
        montoPagado: amort.montoPagado,
        pagoInteres: amort.pagoInteres,
        abonoCapital: amort.abonoCapital,
      },
      pagado: montoPago,
      saldoAnterior: currentSaldo,
      saldoNuevo: nuevoSaldo,
      liquidada: nuevoEstado === 'saldada',
    })

    // Push notification de pago realizado
    const debtName = existing.nombre
    sendPushToUser(userId, {
      title: nuevoEstado === 'saldada' ? '🎉 ¡Deuda liquidada!' : '✅ Pago registrado',
      body: nuevoEstado === 'saldada'
        ? `¡Felicidades! Terminaste de pagar "${debtName}".`
        : `Pagaste $${montoPago.toLocaleString('es-CO')} de "${debtName}". Saldo restante: $${nuevoSaldo.toLocaleString('es-CO')}`,
      tag: 'debt-payment',
      url: '/obligaciones',
    }).catch(() => {})
  } catch (error) {
    console.error('[PayDebt]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── POST /debts/:id/undo-pay ─────────────────────────────────────────────────
// Revierte un pago de cuota. Devuelve el monto al saldoRestante y al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId, pagadoEstePeriodo: true } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda pagada no encontrada' })
      return
    }

    // Usar el monto REAL que se pagó (guardado en montoPagadoEstePeriodo)
    // Si no existe el campo, fallback a cuotaPeriodo
    const montoDevolver = existing.montoPagadoEstePeriodo
      ? Number(existing.montoPagadoEstePeriodo)
      : Number(existing.cuotaPeriodo)

    // Transacción atómica: revertir deuda + devolver cashBalance
    const [debt, user] = await prisma.$transaction([
      prisma.debt.update({
        where: { id },
        data: {
          saldoRestante: { increment: montoDevolver },
          pagadoEstePeriodo: false,
          montoPagadoEstePeriodo: null, // Limpiar el registro del pago
          estado: 'activa',
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: montoDevolver },
        },
        select: {
          cashBalance: true,
          walletAhorro: true,
          walletObligaciones: true,
          walletLibre: true,
          walletEndeudamiento: true,
        },
      }),
    ])

    res.json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        montoPagadoEstePeriodo: null,
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
      },
      montoDevuelto: montoDevolver,
      wallet: {
        cashBalance: Number(user.cashBalance),
        ahorro: Number(user.walletAhorro),
        obligaciones: Number(user.walletObligaciones),
        libre: Number(user.walletLibre),
        endeudamiento: Number(user.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[UndoPayDebt]', error)
    res.status(500).json({ error: 'Error al deshacer pago de deuda' })
  }
})

// ─── PATCH /debts/:id ─────────────────────────────────────────────────────────

router.patch('/:id', validate(updateDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    const debt = await prisma.debt.update({
      where: { id },
      data: req.body,
    })

    res.json({
      debt: { ...debt, montoTotal: Number(debt.montoTotal), saldoRestante: Number(debt.saldoRestante), cuotaPeriodo: Number(debt.cuotaPeriodo), tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null },
    })
  } catch (error) {
    console.error('[UpdateDebt]', error)
    res.status(500).json({ error: 'Error al actualizar deuda' })
  }
})

// ─── DELETE /debts/:id ────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    await prisma.debt.delete({ where: { id } })
    res.json({ message: 'Deuda eliminada' })
  } catch (error) {
    console.error('[DeleteDebt]', error)
    res.status(500).json({ error: 'Error al eliminar deuda' })
  }
})

// ─── POST /debts/pay-with-card — Pagar obligación con tarjeta de crédito en cuotas ─
// Recibe: tarjetaId, monto, cuotas, sourceType (debt|fixed), sourceId
// Lógica:
//   1. Marca la obligación original como pagada
//   2. Suma el monto total al saldoRestante de la tarjeta
//   3. Suma (monto / cuotas) a la cuotaPeriodo de la tarjeta

const payWithCardSchema = z.object({
  tarjetaId: z.string().uuid(),
  monto: z.number().min(0.01),
  cuotas: z.number().int().min(1).max(48),
  sourceType: z.enum(['debt', 'fixed']),
  sourceId: z.string().uuid(),
})

router.post('/pay-with-card', validate(payWithCardSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { tarjetaId, monto, cuotas, sourceType, sourceId } = req.body

    // Verificar que la tarjeta existe y pertenece al usuario
    const tarjeta = await prisma.debt.findFirst({
      where: { id: tarjetaId, userId, estado: 'activa' },
    })
    if (!tarjeta) {
      res.status(404).json({ error: 'Tarjeta de crédito no encontrada' })
      return
    }

    // Calcular incremento de cuota = monto / cuotas
    const incrementoCuota = Math.round((monto / cuotas) * 100) / 100

    if (sourceType === 'debt') {
      // Verificar que la deuda existe
      const deuda = await prisma.debt.findFirst({ where: { id: sourceId, userId, estado: 'activa' } })
      if (!deuda) {
        res.status(404).json({ error: 'Deuda no encontrada' })
        return
      }

      const montoPago = monto
      const currentSaldo = Number(deuda.saldoRestante)
      const nuevoSaldo = Math.max(0, currentSaldo - montoPago)
      const nuevoEstado = nuevoSaldo <= 0 ? 'saldada' : 'activa'

      await prisma.$transaction([
        // Marcar la deuda original como pagada
        prisma.debt.update({
          where: { id: sourceId },
          data: {
            saldoRestante: nuevoSaldo,
            pagadoEstePeriodo: true,
            montoPagadoEstePeriodo: montoPago,
            estado: nuevoEstado,
          },
        }),
        // Incrementar saldo y cuota de la tarjeta
        prisma.debt.update({
          where: { id: tarjetaId },
          data: {
            saldoRestante: { increment: monto },
            saldoPrincipal: { increment: monto },
            cuotaPeriodo: { increment: incrementoCuota },
          },
        }),
      ])
    } else {
      // sourceType === 'fixed'
      const gasto = await prisma.fixedExpense.findFirst({ where: { id: sourceId, userId } })
      if (!gasto) {
        res.status(404).json({ error: 'Gasto fijo no encontrado' })
        return
      }

      const montoTotal = Number(gasto.monto)
      const montoPorPeriodo = gasto.frecuencia === 'quincenal' ? Math.round(montoTotal / 2) : montoTotal
      const montoPago = monto || montoPorPeriodo
      const prevPaid = Number(gasto.montoPagadoEstePeriodo ?? 0)
      const totalPaid = prevPaid + montoPago
      const isFullyPaid = totalPaid >= montoTotal

      await prisma.$transaction([
        // Marcar gasto fijo como pagado
        prisma.fixedExpense.update({
          where: { id: sourceId },
          data: { pagadoEstePeriodo: isFullyPaid, montoPagadoEstePeriodo: totalPaid },
        }),
        // Incrementar saldo y cuota de la tarjeta
        prisma.debt.update({
          where: { id: tarjetaId },
          data: {
            saldoRestante: { increment: monto },
            saldoPrincipal: { increment: monto },
            cuotaPeriodo: { increment: incrementoCuota },
          },
        }),
      ])
    }

    // Obtener estado actualizado de la tarjeta
    const tarjetaActualizada = await prisma.debt.findUnique({ where: { id: tarjetaId } })

    res.json({
      success: true,
      tarjeta: tarjetaActualizada ? {
        id: tarjetaActualizada.id,
        nombre: tarjetaActualizada.nombre,
        saldoRestante: Number(tarjetaActualizada.saldoRestante),
        cuotaPeriodo: Number(tarjetaActualizada.cuotaPeriodo),
      } : null,
      cuotasAgregadas: cuotas,
      incrementoCuota,
      montoTotalAgregado: monto,
    })
  } catch (error) {
    console.error('[PayWithCard]', error)
    res.status(500).json({ error: 'Error al pagar con tarjeta' })
  }
})

export default router
