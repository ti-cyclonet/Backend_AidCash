import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const transactionSchema = z.object({
  monto: z.number().min(0.01, 'El monto debe ser mayor a 0'),
  tipo: z.enum(['aporte', 'retiro']),
  nota: z.string().optional(),
})

// ─── GET /emergency-fund ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fondoEmergenciaActual: true },
    })

    const history = await prisma.emergencyFundHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    res.json({
      fondoActual: Number(user?.fondoEmergenciaActual ?? 0),
      history,
    })
  } catch (error) {
    console.error('[GetEmergencyFund]', error)
    res.status(500).json({ error: 'Error al obtener fondo de emergencia' })
  }
})

// ─── POST /emergency-fund/transaction ─────────────────────────────────────────

router.post('/transaction', validate(transactionSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo, nota } = req.body

    const periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    // Calcular nuevo saldo
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fondoEmergenciaActual: true },
    })

    const fondoActual = Number(user?.fondoEmergenciaActual ?? 0)
    const nuevoFondo = tipo === 'aporte'
      ? fondoActual + monto
      : Math.max(0, fondoActual - monto)

    // Actualizar fondo y registrar historial en una transacción
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { fondoEmergenciaActual: nuevoFondo },
      }),
      prisma.emergencyFundHistory.create({
        data: { userId, periodo, monto, tipo, nota },
      }),
    ])

    res.status(201).json({
      fondoActual: nuevoFondo,
      message: tipo === 'aporte' ? 'Aporte registrado' : 'Retiro registrado',
    })
  } catch (error) {
    console.error('[EmergencyTransaction]', error)
    res.status(500).json({ error: 'Error al registrar transacción del fondo' })
  }
})

export default router
