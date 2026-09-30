import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { planPocketDeduction, planPocketCredit } from '../lib/wallet.js'
import type { Prisma } from '@prisma/client'
import { recordOnboardingAction } from '../lib/missions.js'

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

    // Antes: el navegador descontaba la billetera en una llamada y sumaba al
    // fondo en otra (si una fallaba quedaban descuadrados), un retiro mayor
    // que el fondo se recortaba a 0 en silencio, y nada quedaba en el
    // historial de ahorro (ni en Balance ni en "Ahorros"). Ahora todo va en
    // una sola transacción y con validación.
    // La validación va dentro del mismo UPDATE y el fondo se mueve con
    // increment/decrement: antes se guardaba un valor calculado con una lectura
    // previa, y dos aportes seguidos cobraban dos veces pero sumaban uno.
    const aporte = tipo === 'aporte'
    const nuevoFondo = await prisma.$transaction(async tx => {
      const r = await tx.user.updateMany({
        where: aporte ? { id: userId, cashBalance: { gte: monto } } : { id: userId, fondoEmergenciaActual: { gte: monto } },
        data: {
          fondoEmergenciaActual: aporte ? { increment: monto } : { decrement: monto },
          ...((aporte ? planPocketDeduction('ahorro', monto) : planPocketCredit('ahorro', monto)) as Prisma.UserUpdateManyMutationInput),
        },
      })
      if (r.count === 0) return null
      await tx.emergencyFundHistory.create({ data: { userId, periodo, monto, tipo, nota } })
      await tx.savingsHistory.create({ data: { userId, periodo, monto, tipo: aporte ? 'ahorro' : 'retiro' } })
      const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { fondoEmergenciaActual: true } })
      return Number(u.fondoEmergenciaActual)
    })

    if (nuevoFondo === null) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { fondoEmergenciaActual: true, cashBalance: true } })
      res.status(400).json(aporte
        ? { error: 'Saldo insuficiente', disponible: Number(user?.cashBalance ?? 0), requerido: monto }
        : { error: 'El fondo de emergencia no tiene ese saldo', disponible: Number(user?.fondoEmergenciaActual ?? 0), requerido: monto })
      return
    }

    if (aporte) await recordOnboardingAction(userId, 'registrar_ahorro')

    res.status(201).json({
      fondoActual: nuevoFondo,
      message: aporte ? 'Aporte registrado' : 'Retiro registrado',
    })
  } catch (error) {
    console.error('[EmergencyTransaction]', error)
    res.status(500).json({ error: 'Error al registrar transacción del fondo' })
  }
})

export default router
