import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

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

router.post('/', validate(createDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, montoTotal, cuotaPeriodo, acreedor, frecuenciaPago, diasPago, tasaInteres, prioridad } = req.body

    const debt = await prisma.debt.create({
      data: {
        userId,
        nombre,
        montoTotal,
        saldoRestante: montoTotal, // Al crear, saldo = total
        cuotaPeriodo,
        acreedor: acreedor || '',
        frecuenciaPago: frecuenciaPago || 'mensual',
        diasPago: diasPago || '1',
        tasaInteres: tasaInteres ?? null,
        prioridad: prioridad || 'media',
        pagadoEstePeriodo: false,
        estado: 'activa',
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
// Registra un pago de cuota. Resta del saldoRestante.
// Si el saldo llega a 0, marca la deuda como saldada.

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
    const nuevoSaldo = Math.max(0, currentSaldo - montoPago)
    const nuevoEstado = nuevoSaldo <= 0 ? 'saldada' : 'activa'

    const debt = await prisma.debt.update({
      where: { id },
      data: {
        saldoRestante: nuevoSaldo,
        pagadoEstePeriodo: true,
        estado: nuevoEstado,
      },
    })

    res.json({
      debt: { ...debt, montoTotal: Number(debt.montoTotal), saldoRestante: Number(debt.saldoRestante), cuotaPeriodo: Number(debt.cuotaPeriodo), tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null },
      pagado: montoPago,
      saldoAnterior: currentSaldo,
      saldoNuevo: nuevoSaldo,
      liquidada: nuevoEstado === 'saldada',
    })
  } catch (error) {
    console.error('[PayDebt]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
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

export default router
