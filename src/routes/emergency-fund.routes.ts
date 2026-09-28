import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { planPocketDeduction, planPocketCredit } from '../lib/wallet.js'

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
    const { monto, tipo, nota } = req.body as { monto: number; tipo: 'aporte' | 'retiro'; nota?: string }

    const periodo = new Date().toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fondoEmergenciaActual: true, cashBalance: true },
    })
    const fondoActual = Number(user?.fondoEmergenciaActual ?? 0)

    // Antes: el navegador descontaba la billetera en una llamada y sumaba al
    // fondo en otra (si una fallaba quedaban descuadrados), un retiro mayor
    // que el fondo se recortaba a 0 en silencio, y nada quedaba en el
    // historial de ahorro (ni en Balance ni en "Ahorros"). Ahora todo va en
    // una sola transacción y con validación.
    if (tipo === 'aporte' && Number(user?.cashBalance ?? 0) < monto) {
      res.status(400).json({ error: 'Saldo insuficiente', disponible: Number(user?.cashBalance ?? 0), requerido: monto })
      return
    }
    if (tipo === 'retiro' && fondoActual < monto) {
      res.status(400).json({ error: 'El fondo de emergencia no tiene ese saldo', disponible: fondoActual, requerido: monto })
      return
    }
    const nuevoFondo = tipo === 'aporte' ? fondoActual + monto : fondoActual - monto

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          fondoEmergenciaActual: nuevoFondo,
          ...(tipo === 'aporte' ? planPocketDeduction('ahorro', monto) : planPocketCredit('ahorro', monto)),
        },
      }),
      prisma.emergencyFundHistory.create({
        data: { userId, periodo, monto, tipo, nota },
      }),
      prisma.savingsHistory.create({
        data: { userId, periodo, monto, tipo: tipo === 'aporte' ? 'ahorro' : 'retiro' },
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
