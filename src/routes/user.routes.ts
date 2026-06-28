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

const walletIncomeSchema = z.object({
  monto: z.number().min(0.01),
  tipo: z.enum(['salario', 'extra']),
}).strict()

const walletDeductSchema = z.object({
  monto: z.number().min(0.01),
  bolsillo: z.enum(['obligaciones', 'libre', 'ahorro']),
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

// ─── POST /users/wallet/income ─────────────────────────────────────────────────
// Registra un ingreso real y lo distribuye automáticamente en los 4 bolsillos
// según los porcentajes de la distribución inteligente.

router.post('/wallet/income', validate(walletIncomeSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo } = req.body as { monto: number; tipo: 'salario' | 'extra' }

    // Obtener datos del usuario para calcular distribución
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { ingresoBase: true, frecuenciaIngreso: true },
    })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    // Obtener obligaciones actuales para calcular porcentajes del EMBUDO
    // Filtrar por periodo: si es quincenal, solo cuenta las del periodo actual
    const [debts, fixedExpenses] = await Promise.all([
      prisma.debt.findMany({ where: { userId, estado: 'activa' }, select: { cuotaPeriodo: true, fechaVencimiento: true } }),
      prisma.fixedExpense.findMany({ where: { userId }, select: { monto: true, fechaCorte: true } }),
    ])

    const frecuencia = user.frecuenciaIngreso || 'mensual'
    const ingresoBase = Number(user.ingresoBase) || monto

    // Filtrar obligaciones por periodo
    const currentDay = new Date().getDate()
    const isFirstHalf = currentDay <= 15

    function getDayFromDate(dateStr: string): number {
      if (!dateStr) return 1
      if (dateStr.includes('-')) {
        const parts = dateStr.split('-')
        return parseInt(parts[parts.length - 1], 10) || 1
      }
      return parseInt(dateStr, 10) || 1
    }

    let periodDebts = debts
    let periodFixed = fixedExpenses

    if (frecuencia === 'quincenal') {
      // Solo contar obligaciones cuya fecha cae en la quincena actual
      periodDebts = debts.filter(d => {
        const day = getDayFromDate(d.fechaVencimiento)
        return isFirstHalf ? day <= 15 : day >= 16
      })
      periodFixed = fixedExpenses.filter(f => {
        const day = getDayFromDate(f.fechaCorte)
        return isFirstHalf ? day <= 15 : day >= 16
      })
    }

    const totalObligations = periodDebts.reduce((s, d) => s + Number(d.cuotaPeriodo), 0) +
                             periodFixed.reduce((s, f) => s + Number(f.monto), 0)

    // Ingreso del periodo: si quincenal = mitad del base, si mensual = completo
    const ingresoPeriodo = frecuencia === 'quincenal' ? ingresoBase / 2 : ingresoBase
    const obligationsPct = ingresoPeriodo > 0 ? Math.min((totalObligations / ingresoPeriodo) * 100, 100) : 0
    const remainingPct = Math.max(0, 100 - obligationsPct)

    console.log('[WalletIncome] Debug:', { ingresoBase, frecuencia, ingresoPeriodo, totalObligations, obligationsPct, remainingPct, monto, isFirstHalf })

    // Distribución según el porcentaje real de obligaciones
    // Si obligaciones >= 100%: todo va a obligaciones, lo demás en 0 (realista)
    let finalObligPct: number
    let savingsPct: number
    let dailyFreePct: number
    let debtCapPct: number

    if (obligationsPct >= 100) {
      // Estado crítico: todo el ingreso va a obligaciones
      finalObligPct = 100
      savingsPct = 0
      dailyFreePct = 0
      debtCapPct = 0
    } else if (remainingPct < 15) {
      // Muy ajustado: dar mínimos
      finalObligPct = obligationsPct
      savingsPct = 5
      dailyFreePct = Math.max(5, remainingPct - 5)
      debtCapPct = 0
    } else {
      finalObligPct = obligationsPct
      if (remainingPct >= 40) savingsPct = 20
      else if (remainingPct >= 25) savingsPct = 15
      else if (remainingPct >= 15) savingsPct = 10
      else savingsPct = 5

      const freeInvPct = Math.max(0, remainingPct - savingsPct)
      const minFreePct = 15
      dailyFreePct = Math.min(freeInvPct, minFreePct)
      debtCapPct = Math.max(0, freeInvPct - dailyFreePct)
    }

    // Normalizar porcentajes a 100% y distribuir el monto real
    const totalPct = finalObligPct + savingsPct + dailyFreePct + debtCapPct
    const aObligaciones = Math.round((finalObligPct / totalPct) * monto * 100) / 100
    const aAhorro = Math.round((savingsPct / totalPct) * monto * 100) / 100
    const aLibre = Math.round((dailyFreePct / totalPct) * monto * 100) / 100
    const aEndeudamiento = Math.round((monto - aObligaciones - aAhorro - aLibre) * 100) / 100

    console.log('[WalletIncome] Distribución:', { finalObligPct, savingsPct, dailyFreePct, debtCapPct, aObligaciones, aAhorro, aLibre, aEndeudamiento })

    // Transacción: crear registro + actualizar wallet + cashBalance
    const [record, updated] = await prisma.$transaction([
      prisma.incomeRecord.create({
        data: { userId, monto, tipo, aAhorro, aObligaciones, aLibre, aEndeudamiento },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: monto },
          walletAhorro: { increment: aAhorro },
          walletObligaciones: { increment: aObligaciones },
          walletLibre: { increment: aLibre },
          walletEndeudamiento: { increment: aEndeudamiento },
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

    res.status(201).json({
      record: { ...record, monto: Number(record.monto) },
      wallet: {
        cashBalance: Number(updated.cashBalance),
        ahorro: Number(updated.walletAhorro),
        obligaciones: Number(updated.walletObligaciones),
        libre: Number(updated.walletLibre),
        endeudamiento: Number(updated.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[WalletIncome]', error)
    res.status(500).json({ error: 'Error al registrar ingreso' })
  }
})

// ─── POST /users/wallet/deduct ────────────────────────────────────────────────
// Deduce un monto de un bolsillo específico (obligaciones o libre)

router.post('/wallet/deduct', validate(walletDeductSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, bolsillo } = req.body as { monto: number; bolsillo: 'obligaciones' | 'libre' | 'ahorro' }

    const field = bolsillo === 'obligaciones' ? 'walletObligaciones'
                : bolsillo === 'ahorro' ? 'walletAhorro'
                : 'walletLibre'

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        cashBalance: { decrement: monto },
        [field]: { decrement: monto },
      },
      select: {
        cashBalance: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletLibre: true,
        walletEndeudamiento: true,
      },
    })

    res.json({
      wallet: {
        cashBalance: Number(user.cashBalance),
        ahorro: Number(user.walletAhorro),
        obligaciones: Number(user.walletObligaciones),
        libre: Number(user.walletLibre),
        endeudamiento: Number(user.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[WalletDeduct]', error)
    res.status(500).json({ error: 'Error al deducir del bolsillo' })
  }
})

// ─── GET /users/wallet ────────────────────────────────────────────────────────
// Devuelve el estado actual de la billetera

router.get('/wallet', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        cashBalance: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletLibre: true,
        walletEndeudamiento: true,
      },
    })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    res.json({
      wallet: {
        cashBalance: Number(user.cashBalance),
        ahorro: Number(user.walletAhorro),
        obligaciones: Number(user.walletObligaciones),
        libre: Number(user.walletLibre),
        endeudamiento: Number(user.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[GetWallet]', error)
    res.status(500).json({ error: 'Error al obtener billetera' })
  }
})

// ─── POST /users/wallet/reset ─────────────────────────────────────────────────
// Resetea toda la billetera a 0

router.post('/wallet/reset', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    await prisma.user.update({
      where: { id: userId },
      data: {
        cashBalance: 0,
        walletAhorro: 0,
        walletObligaciones: 0,
        walletLibre: 0,
        walletEndeudamiento: 0,
      },
    })
    res.json({ wallet: { cashBalance: 0, ahorro: 0, obligaciones: 0, libre: 0, endeudamiento: 0 } })
  } catch (error) {
    console.error('[WalletReset]', error)
    res.status(500).json({ error: 'Error al resetear billetera' })
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
          walletAhorro: true,
          walletObligaciones: true,
          walletLibre: true,
          walletEndeudamiento: true,
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
