import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  partnerId: z.string().min(1),
  nombre:    z.string().min(1),
  meta:      z.number().min(0).optional(),
})

const depositSchema = z.object({
  monto: z.number().min(0.01),
  nota:  z.string().optional(),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Verifica que ambos usuarios tengan una conexión ACCEPTED */
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

/**
 * Calcula la división proporcional de un gasto según los ingresos de ambos usuarios.
 * Si A gana el 70% del ingreso combinado, A paga el 70% del gasto.
 */
export function calculateProportionalSplit(
  gastoTotal: number,
  ingresoA: number,
  ingresoB: number
): { montoA: number; montoB: number; pctA: number; pctB: number } {
  const total = ingresoA + ingresoB
  if (total <= 0) {
    const half = gastoTotal / 2
    return { montoA: half, montoB: half, pctA: 50, pctB: 50 }
  }
  const pctA = Math.round((ingresoA / total) * 100)
  const pctB = 100 - pctA
  const montoA = Math.round((gastoTotal * pctA) / 100)
  const montoB = gastoTotal - montoA
  return { montoA, montoB, pctA, pctB }
}

// ─── GET /shared-pockets ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const pockets = await prisma.sharedPocket.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      include: {
        userA:    { select: { id: true, nombre: true, correo: true } },
        userB:    { select: { id: true, nombre: true, correo: true } },
        deposits: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ pockets: pockets.map(p => ({ ...p, balance: Number(p.balance), meta: Number(p.meta) })) })
  } catch (error) {
    console.error('[GetSharedPockets]', error)
    res.status(500).json({ error: 'Error al obtener bolsillos compartidos' })
  }
})

// ─── POST /shared-pockets ─────────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { partnerId, nombre, meta = 0 } = req.body as { partnerId: string; nombre: string; meta?: number }

    if (userId === partnerId) {
      res.status(400).json({ error: 'No puedes crear un bolsillo contigo mismo' })
      return
    }

    const connected = await requireConnection(userId, partnerId)
    if (!connected) {
      res.status(403).json({ error: 'Solo puedes crear bolsillos con usuarios conectados' })
      return
    }

    const pocket = await prisma.sharedPocket.create({
      data: { userAId: userId, userBId: partnerId, nombre, meta, balance: 0 },
      include: {
        userA: { select: { id: true, nombre: true } },
        userB: { select: { id: true, nombre: true } },
      },
    })

    emitToUser(partnerId, SOCKET_EVENTS.SHARED_DEPOSIT, {
      type: 'pocket_created',
      pocketId: pocket.id,
      nombre: pocket.nombre,
      by: pocket.userA,
    })

    res.status(201).json({ pocket: { ...pocket, balance: Number(pocket.balance), meta: Number(pocket.meta) } })
  } catch (error) {
    console.error('[CreateSharedPocket]', error)
    res.status(500).json({ error: 'Error al crear bolsillo compartido' })
  }
})

// ─── POST /shared-pockets/:id/deposit ────────────────────────────────────────

router.post('/:id/deposit', validate(depositSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const pocketId = req.params.id as string
    const { monto, nota } = req.body as { monto: number; nota?: string }

    const pocket = await prisma.sharedPocket.findFirst({
      where: { id: pocketId, OR: [{ userAId: userId }, { userBId: userId }] },
      include: {
        userA: { select: { id: true, nombre: true } },
        userB: { select: { id: true, nombre: true } },
      },
    })
    if (!pocket) {
      res.status(404).json({ error: 'Bolsillo no encontrado' })
      return
    }

    // Registrar depósito y actualizar balance en una transacción
    const [deposit, updated] = await prisma.$transaction([
      prisma.sharedDeposit.create({
        data: { sharedPocketId: pocketId, userId, monto, nota },
      }),
      prisma.sharedPocket.update({
        where: { id: pocketId },
        data: { balance: { increment: monto } },
      }),
    ])

    const depositor = userId === pocket.userAId ? pocket.userA : pocket.userB
    const partner   = userId === pocket.userAId ? pocket.userB : pocket.userA

    // Notificar al compañero
    emitToUser(partner.id, SOCKET_EVENTS.SHARED_DEPOSIT, {
      type: 'deposit',
      pocketId,
      pocketName: pocket.nombre,
      monto,
      nota,
      newBalance: Number(updated.balance),
      by: depositor,
    })

    res.status(201).json({
      deposit: { ...deposit, monto: Number(deposit.monto) },
      newBalance: Number(updated.balance),
    })
  } catch (error) {
    console.error('[SharedDeposit]', error)
    res.status(500).json({ error: 'Error al depositar' })
  }
})

// ─── GET /shared-pockets/split-calculator ────────────────────────────────────
// Calcula la división proporcional basada en ingresos de ambos usuarios

router.get('/split-calculator', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId   = req.user!.userId
    const partnerId = req.query.partnerId as string
    const gasto    = Number(req.query.gasto ?? 0)

    if (!partnerId || gasto <= 0) {
      res.status(400).json({ error: 'partnerId y gasto son requeridos' })
      return
    }

    const connected = await requireConnection(userId, partnerId)
    if (!connected) {
      res.status(403).json({ error: 'Solo puedes calcular con usuarios conectados' })
      return
    }

    const [userA, userB] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId },    select: { nombre: true, ingresoBase: true } }),
      prisma.user.findUnique({ where: { id: partnerId }, select: { nombre: true, ingresoBase: true } }),
    ])

    const split = calculateProportionalSplit(
      gasto,
      Number(userA?.ingresoBase ?? 0),
      Number(userB?.ingresoBase ?? 0)
    )

    res.json({
      gasto,
      userA: { id: userId,    nombre: userA?.nombre, ingreso: Number(userA?.ingresoBase), ...{ monto: split.montoA, pct: split.pctA } },
      userB: { id: partnerId, nombre: userB?.nombre, ingreso: Number(userB?.ingresoBase), ...{ monto: split.montoB, pct: split.pctB } },
    })
  } catch (error) {
    console.error('[SplitCalculator]', error)
    res.status(500).json({ error: 'Error al calcular división' })
  }
})

export default router
