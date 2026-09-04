import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { planPocketDeduction, planPocketCredit } from '../lib/wallet.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas de validación ────────────────────────────────────────────────────

const createPocketSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido').max(50),
  meta: z.number().min(0).default(0),
  montoActual: z.number().min(0).default(0),
  color: z.string().default('#10B981'),
  icono: z.string().default('piggy-bank'),
  descripcion: z.string().max(200).optional(),
  pagoAutomatico: z.boolean().default(false),
  tipoMeta: z.enum(['libre', 'fecha']).default('libre'),
  fechaLimite: z.string().optional(),
})

const updatePocketSchema = z.object({
  nombre: z.string().min(1).max(50).optional(),
  meta: z.number().min(0).optional(),
  montoActual: z.number().min(0).optional(),
  color: z.string().optional(),
  icono: z.string().optional(),
  descripcion: z.string().max(200).optional(),
  pagoAutomatico: z.boolean().optional(),
  tipoMeta: z.enum(['libre', 'fecha']).optional(),
  fechaLimite: z.string().optional(),
})

const pocketTxSchema = z.object({
  monto: z.number().min(0.01),
})

/** Schema para bulk insert (migración desde localStorage) */
const bulkCreateSchema = z.object({
  pockets: z.array(createPocketSchema).min(1).max(50),
})

// ─── GET /savings-pockets — Listar bolsillos del usuario ──────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const pockets = await prisma.savingsPocket.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })

    res.json({ pockets })
  } catch (error) {
    console.error('[GetSavingsPockets]', error)
    res.status(500).json({ error: 'Error al obtener bolsillos de ahorro' })
  }
})

// ─── POST /savings-pockets — Crear un bolsillo ───────────────────────────────

router.post('/', validate(createPocketSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, meta, montoActual, color, icono } = req.body

    const pocket = await prisma.savingsPocket.create({
      data: { userId, nombre, meta, montoActual, color, icono },
    })

    res.status(201).json({ pocket })
  } catch (error) {
    console.error('[CreateSavingsPocket]', error)
    res.status(500).json({ error: 'Error al crear bolsillo de ahorro' })
  }
})

// ─── POST /savings-pockets/bulk — Bulk insert (migración localStorage) ────────

router.post('/bulk', validate(bulkCreateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { pockets } = req.body

    const created = await prisma.savingsPocket.createMany({
      data: pockets.map((p: z.infer<typeof createPocketSchema>) => ({
        userId,
        nombre: p.nombre,
        meta: p.meta,
        montoActual: p.montoActual,
        color: p.color,
        icono: p.icono,
        descripcion: p.descripcion,
        pagoAutomatico: p.pagoAutomatico,
        tipoMeta: p.tipoMeta,
        fechaLimite: p.fechaLimite,
      })),
    })

    res.status(201).json({ count: created.count, message: 'Bolsillos migrados correctamente' })
  } catch (error) {
    console.error('[BulkCreateSavingsPockets]', error)
    res.status(500).json({ error: 'Error al migrar bolsillos de ahorro' })
  }
})

// ─── PATCH /savings-pockets/:id — Actualizar un bolsillo ──────────────────────

router.patch('/:id', validate(updatePocketSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    // Verificar que el bolsillo pertenece al usuario
    const existing = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    const pocket = await prisma.savingsPocket.update({
      where: { id },
      data: req.body,
    })

    res.json({ pocket })
  } catch (error) {
    console.error('[UpdateSavingsPocket]', error)
    res.status(500).json({ error: 'Error al actualizar bolsillo de ahorro' })
  }
})

// ─── POST /savings-pockets/:id/deposit — Aportar al bolsillo ──────────────────
// Descuenta cashBalance (y el bolsillo notional "ahorro" de la billetera) y
// suma montoActual del bolsillo, todo en una sola transacción atómica.

router.post('/:id/deposit', validate(pocketTxSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { monto } = req.body as { monto: number }

    const pocket = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!pocket) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { cashBalance: true } })
    if (!user || Number(user.cashBalance) < monto) {
      res.status(400).json({ error: 'Saldo insuficiente', disponible: Number(user?.cashBalance ?? 0), requerido: monto })
      return
    }

    // El aporte ya se validó contra el cashBalance total, así que se descuenta
    // completo — y walletAhorro por ese MISMO monto para que cashBalance y el
    // bolsillo notional no se desincronicen.
    const walletData = planPocketDeduction('ahorro', monto)
    const periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    const [updatedPocket] = await prisma.$transaction([
      prisma.savingsPocket.update({ where: { id }, data: { montoActual: { increment: monto } } }),
      prisma.user.update({ where: { id: userId }, data: walletData }),
      // Antes este endpoint no dejaba NINGÚN rastro en el historial — el
      // depósito era real (la billetera sí bajaba) pero invisible en
      // Balance/PDF. Mismo modelo que usa el registro de ahorro "libre".
      prisma.savingsHistory.create({ data: { userId, periodo, monto, tipo: 'ahorro' } }),
    ])

    res.json({ pocket: updatedPocket })
  } catch (error) {
    console.error('[DepositSavingsPocket]', error)
    res.status(500).json({ error: 'Error al aportar al bolsillo' })
  }
})

// ─── POST /savings-pockets/:id/withdraw — Retirar del bolsillo ────────────────
// Devuelve el dinero a cashBalance (y al bolsillo notional "ahorro"), y resta
// montoActual del bolsillo — atómico, y topado por lo que el bolsillo tiene
// realmente (no se puede retirar más de lo que contiene).

router.post('/:id/withdraw', validate(pocketTxSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { monto } = req.body as { monto: number }

    const pocket = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!pocket) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }
    if (Number(pocket.montoActual) < monto) {
      res.status(400).json({ error: 'El bolsillo no tiene suficiente saldo', disponible: Number(pocket.montoActual), requerido: monto })
      return
    }

    const periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    const [updatedPocket] = await prisma.$transaction([
      prisma.savingsPocket.update({ where: { id }, data: { montoActual: { decrement: monto } } }),
      prisma.user.update({ where: { id: userId }, data: planPocketCredit('ahorro', monto) }),
      prisma.savingsHistory.create({ data: { userId, periodo, monto, tipo: 'retiro' } }),
    ])

    res.json({ pocket: updatedPocket })
  } catch (error) {
    console.error('[WithdrawSavingsPocket]', error)
    res.status(500).json({ error: 'Error al retirar del bolsillo' })
  }
})

// ─── DELETE /savings-pockets/:id — Eliminar un bolsillo ───────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.savingsPocket.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    // Si el bolsillo tenía dinero real, devolverlo a la billetera ANTES de
    // borrarlo — de lo contrario borrar un bolsillo con saldo lo destruiría.
    const remaining = Number(existing.montoActual)
    if (remaining > 0) {
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: planPocketCredit('ahorro', remaining) }),
        prisma.savingsPocket.delete({ where: { id } }),
      ])
    } else {
      await prisma.savingsPocket.delete({ where: { id } })
    }

    res.json({ message: 'Bolsillo eliminado correctamente', devuelto: remaining })
  } catch (error) {
    console.error('[DeleteSavingsPocket]', error)
    res.status(500).json({ error: 'Error al eliminar bolsillo de ahorro' })
  }
})

export default router
