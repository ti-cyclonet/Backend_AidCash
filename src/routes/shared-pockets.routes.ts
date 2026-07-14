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
  partnerIds: z.array(z.string().min(1)).min(1), // Ahora soporta múltiples miembros
  nombre: z.string().min(1),
  meta: z.number().min(0).optional(),
})

const depositSchema = z.object({
  monto: z.number().min(0.01),
  nota: z.string().optional(),
  tipo: z.enum(['aporte', 'retiro']).default('aporte'),
})

const respondSchema = z.object({
  depositId: z.string().min(1),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

export function calculateProportionalSplit(
  gastoTotal: number, ingresoA: number, ingresoB: number
): { montoA: number; montoB: number; pctA: number; pctB: number } {
  const total = ingresoA + ingresoB
  if (total <= 0) return { montoA: gastoTotal / 2, montoB: gastoTotal / 2, pctA: 50, pctB: 50 }
  const pctA = Math.round((ingresoA / total) * 100)
  const pctB = 100 - pctA
  return { montoA: Math.round((gastoTotal * pctA) / 100), montoB: gastoTotal - Math.round((gastoTotal * pctA) / 100), pctA, pctB }
}

// ─── GET /shared-pockets ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    // Buscar bolsillos donde el usuario es miembro
    const pockets = await prisma.sharedPocket.findMany({
      where: { members: { some: { userId } } },
      include: {
        members: {
          include: { user: { select: { id: true, nombre: true, correo: true } } },
        },
        deposits: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      pockets: pockets.map(p => ({
        id: p.id,
        nombre: p.nombre,
        balance: Number(p.balance),
        meta: Number(p.meta),
        createdAt: p.createdAt,
        members: p.members.map(m => ({
          id: m.user.id,
          nombre: m.user.nombre,
          correo: m.user.correo,
          role: m.role,
        })),
        deposits: p.deposits.map(d => ({
          ...d,
          monto: Number(d.monto),
        })),
      })),
    })
  } catch (error) {
    console.error('[GetSharedPockets]', error)
    res.status(500).json({ error: 'Error al obtener ahorros compartidos' })
  }
})

// ─── POST /shared-pockets — Crear bolsillo compartido ─────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { partnerIds, nombre, meta = 0 } = req.body as { partnerIds: string[]; nombre: string; meta?: number }

    // Verificar que no se incluya a sí mismo
    const uniquePartners = partnerIds.filter(id => id !== userId)
    if (uniquePartners.length === 0) {
      res.status(400).json({ error: 'Debes incluir al menos un miembro diferente a ti' })
      return
    }

    // Verificar conexiones
    for (const pid of uniquePartners) {
      const connected = await requireConnection(userId, pid)
      if (!connected) {
        res.status(403).json({ error: `No estás conectado con el usuario ${pid}` })
        return
      }
    }

    // Crear bolsillo + miembros en una transacción
    const pocket = await prisma.sharedPocket.create({
      data: {
        nombre,
        meta,
        balance: 0,
        members: {
          create: [
            { userId, role: 'owner' },
            ...uniquePartners.map(pid => ({ userId: pid, role: 'member' })),
          ],
        },
      },
      include: {
        members: { include: { user: { select: { id: true, nombre: true } } } },
      },
    })

    // Notificar a los miembros
    for (const pid of uniquePartners) {
      emitToUser(pid, SOCKET_EVENTS.SHARED_DEPOSIT, {
        type: 'pocket_created',
        pocketId: pocket.id,
        nombre: pocket.nombre,
        by: { id: userId },
      })
    }

    res.status(201).json({
      pocket: { ...pocket, balance: Number(pocket.balance), meta: Number(pocket.meta) },
    })
  } catch (error) {
    console.error('[CreateSharedPocket]', error)
    res.status(500).json({ error: 'Error al crear ahorro compartido' })
  }
})

// ─── POST /shared-pockets/:id/deposit — Aporte o retiro (requiere aprobación) ─

router.post('/:id/deposit', validate(depositSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const pocketId = req.params.id as string
    const { monto, nota, tipo = 'aporte' } = req.body as { monto: number; nota?: string; tipo?: 'aporte' | 'retiro' }

    // Verificar que el usuario es miembro del bolsillo
    const membership = await prisma.sharedPocketMember.findFirst({
      where: { sharedPocketId: pocketId, userId },
    })
    if (!membership) {
      res.status(404).json({ error: 'No eres miembro de este ahorro' })
      return
    }

    // Verificar saldo suficiente para retiros
    if (tipo === 'retiro') {
      const pocket = await prisma.sharedPocket.findUnique({ where: { id: pocketId } })
      if (!pocket || Number(pocket.balance) < monto) {
        res.status(400).json({ error: 'Saldo insuficiente en el ahorro compartido' })
        return
      }
    }

    // Crear depósito con estado PENDING_CONFIRMATION (requiere aprobación de otro miembro)
    const deposit = await prisma.sharedDeposit.create({
      data: {
        sharedPocketId: pocketId,
        userId,
        monto: tipo === 'retiro' ? -monto : monto,
        nota: nota ? `[${tipo === 'retiro' ? 'RETIRO' : 'APORTE'}] ${nota}` : `[${tipo === 'retiro' ? 'RETIRO' : 'APORTE'}]`,
      },
    })

    // Obtener otros miembros para notificar
    const otherMembers = await prisma.sharedPocketMember.findMany({
      where: { sharedPocketId: pocketId, userId: { not: userId } },
      select: { userId: true },
    })

    const depositor = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true } })

    // Notificar a todos los otros miembros
    for (const m of otherMembers) {
      emitToUser(m.userId, SOCKET_EVENTS.SHARED_DEPOSIT, {
        type: tipo,
        pocketId,
        depositId: deposit.id,
        monto,
        nota,
        by: { id: userId, nombre: depositor?.nombre },
        requiresApproval: true,
      })
    }

    // Si el bolsillo solo tiene 1 miembro extra, auto-aplicar (confianza)
    // Si hay múltiples, queda pendiente hasta que alguien confirme
    const totalMembers = otherMembers.length + 1
    if (totalMembers <= 1) {
      // Solo 1 persona — aplicar directamente
      await prisma.sharedPocket.update({
        where: { id: pocketId },
        data: { balance: { increment: tipo === 'retiro' ? -monto : monto } },
      })
    }

    res.status(201).json({
      deposit: { ...deposit, monto: Number(deposit.monto) },
      requiresApproval: totalMembers > 1,
    })
  } catch (error) {
    console.error('[SharedDeposit]', error)
    res.status(500).json({ error: 'Error al registrar movimiento' })
  }
})

// ─── POST /shared-pockets/:id/deposit/:depositId/approve — Confirmar movimiento ─

router.post('/:id/deposit/:depositId/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { id: pocketId, depositId } = req.params

    // Verificar que el usuario es miembro
    const membership = await prisma.sharedPocketMember.findFirst({
      where: { sharedPocketId: pocketId, userId },
    })
    if (!membership) {
      res.status(403).json({ error: 'No eres miembro de este ahorro' })
      return
    }

    // Obtener el depósito
    const deposit = await prisma.sharedDeposit.findFirst({
      where: { id: depositId, sharedPocketId: pocketId },
    })
    if (!deposit) {
      res.status(404).json({ error: 'Movimiento no encontrado' })
      return
    }

    // No puede aprobar su propio movimiento
    if (deposit.userId === userId) {
      res.status(400).json({ error: 'No puedes aprobar tu propio movimiento' })
      return
    }

    // Aplicar el monto al balance
    const updated = await prisma.sharedPocket.update({
      where: { id: pocketId },
      data: { balance: { increment: Number(deposit.monto) } },
    })

    // Notificar al que hizo el depósito
    emitToUser(deposit.userId, SOCKET_EVENTS.SHARED_DEPOSIT, {
      type: 'approved',
      pocketId,
      depositId,
      newBalance: Number(updated.balance),
      approvedBy: userId,
    })

    res.json({ newBalance: Number(updated.balance), message: 'Movimiento aprobado' })
  } catch (error) {
    console.error('[ApproveDeposit]', error)
    res.status(500).json({ error: 'Error al aprobar movimiento' })
  }
})

// ─── POST /shared-pockets/:id/deposit/:depositId/reject — Rechazar movimiento ─

router.post('/:id/deposit/:depositId/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { id: pocketId, depositId } = req.params

    const membership = await prisma.sharedPocketMember.findFirst({
      where: { sharedPocketId: pocketId, userId },
    })
    if (!membership) {
      res.status(403).json({ error: 'No eres miembro de este ahorro' })
      return
    }

    const deposit = await prisma.sharedDeposit.findFirst({
      where: { id: depositId, sharedPocketId: pocketId },
    })
    if (!deposit) {
      res.status(404).json({ error: 'Movimiento no encontrado' })
      return
    }

    // Eliminar el depósito (rechazado)
    await prisma.sharedDeposit.delete({ where: { id: depositId } })

    emitToUser(deposit.userId, SOCKET_EVENTS.SHARED_DEPOSIT, {
      type: 'rejected',
      pocketId,
      depositId,
      rejectedBy: userId,
    })

    res.json({ message: 'Movimiento rechazado' })
  } catch (error) {
    console.error('[RejectDeposit]', error)
    res.status(500).json({ error: 'Error al rechazar movimiento' })
  }
})

// ─── DELETE /shared-pockets/:id — Solicitar eliminación (timer 5 días) ────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const pocketId = req.params.id as string

    const membership = await prisma.sharedPocketMember.findFirst({
      where: { sharedPocketId: pocketId, userId },
    })
    if (!membership) {
      res.status(404).json({ error: 'Ahorro no encontrado' })
      return
    }

    // Verificar si ya tiene una solicitud de eliminación pendiente
    // Usamos el campo nota del último depósito como marcador (hack temporal)
    const pocket = await prisma.sharedPocket.findUnique({
      where: { id: pocketId },
      include: { members: { select: { userId: true } } },
    })
    if (!pocket) {
      res.status(404).json({ error: 'Ahorro no encontrado' })
      return
    }

    const otherMembers = pocket.members.filter(m => m.userId !== userId)

    if (otherMembers.length === 0) {
      // Si es el único miembro, eliminar directamente
      await prisma.sharedPocket.delete({ where: { id: pocketId } })
      res.json({ message: 'Ahorro eliminado', immediate: true })
      return
    }

    // Crear un depósito "marcador" de solicitud de eliminación
    await prisma.sharedDeposit.create({
      data: {
        sharedPocketId: pocketId,
        userId,
        monto: 0,
        nota: `[DELETE_REQUEST] Solicitud de eliminación. Se eliminará automáticamente en 5 días si no se rechaza.`,
      },
    })

    // Notificar a los otros miembros
    const requester = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true } })
    for (const m of otherMembers) {
      emitToUser(m.userId, SOCKET_EVENTS.SHARED_DEPOSIT, {
        type: 'delete_request',
        pocketId,
        pocketName: pocket.nombre,
        by: { id: userId, nombre: requester?.nombre },
        expiresIn: '5 días',
      })
    }

    res.json({
      message: 'Solicitud de eliminación enviada. Se eliminará en 5 días si no se rechaza.',
      immediate: false,
      expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    })
  } catch (error) {
    console.error('[DeleteSharedPocket]', error)
    res.status(500).json({ error: 'Error al solicitar eliminación' })
  }
})

// ─── GET /shared-pockets/split-calculator ────────────────────────────────────

router.get('/split-calculator', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const partnerId = req.query.partnerId as string
    const gasto = Number(req.query.gasto ?? 0)

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
      prisma.user.findUnique({ where: { id: userId }, select: { nombre: true, ingresoBase: true } }),
      prisma.user.findUnique({ where: { id: partnerId }, select: { nombre: true, ingresoBase: true } }),
    ])

    const split = calculateProportionalSplit(gasto, Number(userA?.ingresoBase ?? 0), Number(userB?.ingresoBase ?? 0))

    res.json({
      gasto,
      userA: { id: userId, nombre: userA?.nombre, ingreso: Number(userA?.ingresoBase), monto: split.montoA, pct: split.pctA },
      userB: { id: partnerId, nombre: userB?.nombre, ingreso: Number(userB?.ingresoBase), monto: split.montoB, pct: split.pctB },
    })
  } catch (error) {
    console.error('[SplitCalculator]', error)
    res.status(500).json({ error: 'Error al calcular división' })
  }
})

export default router
