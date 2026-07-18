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

// ─── POST /shared-pockets/:id/deposit — Aporte o retiro ──────────────────────
// - Aportes: descuentan del cashBalance del usuario inmediatamente
// - Retiros: requieren aprobación del owner, al aprobar se suma al cashBalance del solicitante
// - Notifica a todos los miembros del movimiento

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

    if (tipo === 'aporte') {
      // Verificar que el usuario tiene saldo suficiente en su wallet
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { cashBalance: true } })
      if (!user || Number(user.cashBalance) < monto) {
        res.status(400).json({
          error: 'Saldo insuficiente',
          disponible: Number(user?.cashBalance ?? 0),
          requerido: monto,
        })
        return
      }

      // Descontar del wallet del usuario inmediatamente
      await prisma.user.update({
        where: { id: userId },
        data: { cashBalance: { decrement: monto }, walletAhorro: { decrement: Math.min(monto, Number(user.cashBalance)) } },
      })

      // Sumar al balance del bolsillo compartido
      await prisma.sharedPocket.update({
        where: { id: pocketId },
        data: { balance: { increment: monto } },
      })
    }

    if (tipo === 'retiro') {
      // Verificar que hay saldo en el bolsillo
      const pocket = await prisma.sharedPocket.findUnique({ where: { id: pocketId } })
      if (!pocket || Number(pocket.balance) < monto) {
        res.status(400).json({ error: 'Saldo insuficiente en el ahorro compartido' })
        return
      }
      // El retiro NO se aplica inmediatamente — requiere aprobación del owner
    }

    // Crear registro del movimiento
    const deposit = await prisma.sharedDeposit.create({
      data: {
        sharedPocketId: pocketId,
        userId,
        monto: tipo === 'retiro' ? -monto : monto,
        nota: nota ? `[${tipo === 'retiro' ? 'RETIRO_PENDIENTE' : 'APORTE'}] ${nota}` : `[${tipo === 'retiro' ? 'RETIRO_PENDIENTE' : 'APORTE'}]`,
      },
    })

    // Notificar a TODOS los otros miembros
    const allMembers = await prisma.sharedPocketMember.findMany({
      where: { sharedPocketId: pocketId, userId: { not: userId } },
      include: { user: { select: { id: true } } },
    })
    const depositor = await prisma.user.findUnique({ where: { id: userId }, select: { nombre: true } })
    const pocketInfo = await prisma.sharedPocket.findUnique({ where: { id: pocketId }, select: { nombre: true } })

    for (const m of allMembers) {
      emitToUser(m.user.id, SOCKET_EVENTS.SHARED_DEPOSIT, {
        type: tipo,
        pocketId,
        pocketName: pocketInfo?.nombre,
        depositId: deposit.id,
        monto,
        nota,
        by: { id: userId, nombre: depositor?.nombre },
        requiresApproval: tipo === 'retiro',
      })
    }

    // Push notification a todos
    const { pushSavingsDeposit } = await import('../lib/push.js')
    for (const m of allMembers) {
      await pushSavingsDeposit(m.user.id, pocketInfo?.nombre ?? 'ahorro', depositor?.nombre ?? 'Alguien')
    }

    res.status(201).json({
      deposit: { ...deposit, monto: Number(deposit.monto) },
      applied: tipo === 'aporte', // Aportes se aplican inmediatamente
      requiresApproval: tipo === 'retiro', // Retiros esperan aprobación del owner
    })
  } catch (error) {
    console.error('[SharedDeposit]', error)
    res.status(500).json({ error: 'Error al registrar movimiento' })
  }
})

// ─── POST /shared-pockets/:id/deposit/:depositId/approve — Solo el OWNER aprueba ─

router.post('/:id/deposit/:depositId/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const pocketId = req.params.id as string
    const depositId = req.params.depositId as string

    // Verificar que el usuario es el OWNER del bolsillo
    const membership = await prisma.sharedPocketMember.findFirst({
      where: { sharedPocketId: pocketId, userId, role: 'owner' },
    })
    if (!membership) {
      res.status(403).json({ error: 'Solo el creador del ahorro puede aprobar movimientos' })
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

    // No puede aprobar su propio movimiento (a menos que sea un retiro solicitado por otro)
    if (deposit.userId === userId) {
      res.status(400).json({ error: 'No puedes aprobar tu propio movimiento' })
      return
    }

    const montoNum = Number(deposit.monto)
    const isRetiro = montoNum < 0
    const montoAbsoluto = Math.abs(montoNum)

    if (isRetiro) {
      // Retiro aprobado: descontar del bolsillo y SUMAR al cashBalance del solicitante
      await prisma.$transaction([
        prisma.sharedPocket.update({
          where: { id: pocketId },
          data: { balance: { decrement: montoAbsoluto } },
        }),
        prisma.user.update({
          where: { id: deposit.userId },
          data: { cashBalance: { increment: montoAbsoluto } },
        }),
        prisma.sharedDeposit.update({
          where: { id: depositId },
          data: { nota: deposit.nota?.replace('RETIRO_PENDIENTE', 'RETIRO_APROBADO') ?? '[RETIRO_APROBADO]' },
        }),
      ])
    } else {
      // Aporte ya fue aplicado al crear — solo marcar como aprobado
      await prisma.sharedDeposit.update({
        where: { id: depositId },
        data: { nota: deposit.nota?.replace('APORTE', 'APORTE_APROBADO') ?? '[APORTE_APROBADO]' },
      })
    }

    const updated = await prisma.sharedPocket.findUnique({ where: { id: pocketId } })

    // Notificar al solicitante
    emitToUser(deposit.userId, SOCKET_EVENTS.SHARED_DEPOSIT, {
      type: 'approved',
      pocketId,
      depositId,
      monto: montoAbsoluto,
      isRetiro,
      newBalance: Number(updated?.balance ?? 0),
      approvedBy: userId,
    })

    res.json({ newBalance: Number(updated?.balance ?? 0), message: isRetiro ? 'Retiro aprobado. Se sumó al saldo del solicitante.' : 'Movimiento aprobado' })
  } catch (error) {
    console.error('[ApproveDeposit]', error)
    res.status(500).json({ error: 'Error al aprobar movimiento' })
  }
})

// ─── POST /shared-pockets/:id/deposit/:depositId/reject — Rechazar movimiento ─

router.post('/:id/deposit/:depositId/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const pocketId = req.params.id as string
    const depositId = req.params.depositId as string

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
