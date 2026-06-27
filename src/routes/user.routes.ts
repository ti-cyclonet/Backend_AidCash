import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

// ─── Schema ───────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  nombre: z.string().min(2).optional(),
  correo: z.string().email().optional(),
  ingresoBase: z.number().min(0).optional(),
  frecuenciaIngreso: z.enum(['mensual', 'quincenal']).optional(),
  onboardingDone: z.boolean().optional(),
  metaAhorroGlobal: z.number().min(0).optional(),
  fondoEmergenciaActual: z.number().min(0).optional(),
}).strict()

const balanceSchema = z.object({
  monto: z.number(),
  tipo: z.enum(['ingreso', 'reset']),
}).strict()

// ─── PATCH /users/profile ─────────────────────────────────────────────────────

router.patch('/profile', validate(updateProfileSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const data = req.body

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        nombre: true,
        correo: true,
        ingresoBase: true,
        frecuenciaIngreso: true,
        onboardingDone: true,
        metaAhorroGlobal: true,
        saldoAhorroTotal: true,
        fondoEmergenciaActual: true,
        streakActual: true,
        streakMejor: true,
        cashBalance: true,
      },
    })

    res.json({ user })
  } catch (error) {
    console.error('[UpdateProfile]', error)
    res.status(500).json({ error: 'Error al actualizar perfil' })
  }
})

// ─── PATCH /users/balance ─────────────────────────────────────────────────────
// tipo=ingreso: suma monto al cashBalance
// tipo=reset:   pone cashBalance a 0

router.patch('/balance', validate(balanceSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo } = req.body as { monto: number; tipo: 'ingreso' | 'reset' }

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true },
    })
    if (!current) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    const newBalance = tipo === 'reset'
      ? 0
      : Number(current.cashBalance) + monto

    const user = await prisma.user.update({
      where: { id: userId },
      data: { cashBalance: newBalance },
      select: { cashBalance: true },
    })

    res.json({ cashBalance: Number(user.cashBalance) })
  } catch (error) {
    console.error('[UpdateBalance]', error)
    res.status(500).json({ error: 'Error al actualizar balance' })
  }
})

// ─── GET /users/dashboard-summary ─────────────────────────────────────────────

router.get('/dashboard-summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const [user, debts, fixedExpenses, savingsHistory, extraIncomes, impulseExpenses] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          nombre: true,
          ingresoBase: true,
          frecuenciaIngreso: true,
          onboardingDone: true,
          metaAhorroGlobal: true,
          saldoAhorroTotal: true,
          fondoEmergenciaActual: true,
          streakActual: true,
          streakMejor: true,
          cashBalance: true,
        },
      }),
      prisma.debt.findMany({ where: { userId, estado: 'activa' } }),
      prisma.fixedExpense.findMany({ where: { userId } }),
      prisma.savingsHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      prisma.extraIncome.findMany({ where: { userId } }),
      prisma.impulseExpense.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ])

    res.json({
      user,
      debts,
      fixedExpenses,
      savingsHistory,
      extraIncomes,
      impulseExpenses,
    })
  } catch (error) {
    console.error('[DashboardSummary]', error)
    res.status(500).json({ error: 'Error al obtener datos del dashboard' })
  }
})

export default router
