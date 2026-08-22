import { Router, Request, Response } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { sendPushToUser } from '../lib/push.js'
import { env } from '../config/env.js'

const router = Router()
router.use(authMiddleware)

// Rate limit para endpoints de wallet (máx 30 requests por minuto por usuario)
const walletLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => req.user?.userId ?? req.ip ?? 'unknown',
  message: { error: 'Demasiadas operaciones de billetera. Espera un momento.' },
})

// ─── Schema ───────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  nombre: z.string().min(2).optional(),
  correo: z.string().email().optional(),
  ingresoBase: z.number().min(0).optional(),
  frecuenciaIngreso: z.enum(['mensual', 'quincenal']).optional(),
  diasPago: z.array(z.number().min(1).max(31)).max(2).optional(),
  onboardingDone: z.boolean().optional(),
  metaAhorroGlobal: z.number().min(0).optional(),
  fondoEmergenciaActual: z.number().min(0).optional(),
  // Authoriza fields (not saved in Kiri DB)
  firstName: z.string().optional(),
  secondName: z.string().optional(),
  firstSurname: z.string().optional(),
  secondSurname: z.string().optional(),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
})

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
    const { firstName, secondName, firstSurname, secondSurname, documentType, documentNumber, ...localData } = req.body

    // Update local Kiri DB (only local fields)
    const user = await prisma.user.update({
      where: { id: userId },
      data: localData,
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

    // Sync with Authoriza (non-blocking)
    if (firstName || firstSurname || documentType || documentNumber) {
      const correo = localData.correo || user.correo
      try {
        const authorizaUrl = env.AUTHORIZA_API_URL || 'http://localhost:3000'
        
        // Check if user exists in Authoriza
        const checkRes = await fetch(`${authorizaUrl}/api/auth/check-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: correo }),
        })
        const checkData = await checkRes.json() as any

        if (checkData.exists && checkData.userId) {
          // Update user in Authoriza via the users endpoint
          await fetch(`${authorizaUrl}/api/users/${checkData.userId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              naturalPersonData: {
                firstName: firstName || undefined,
                secondName: secondName || undefined,
                firstSurname: firstSurname || undefined,
                secondSurname: secondSurname || undefined,
              },
              documentType: documentType && documentNumber ? {
                strDocumentType: documentType,
                strDocumentNumber: documentNumber,
              } : undefined,
            }),
          })
        } else if (firstName && firstSurname) {
          // Create user in Authoriza if doesn't exist
          await fetch(`${authorizaUrl}/api/users/full`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user: { strUserName: correo, strStatus: 'ACTIVE' },
              basicData: { strPersonType: 'N', strStatus: 'ACTIVE' },
              documentType: { strDocumentType: documentType || 'CC', strDocumentNumber: documentNumber || '' },
              naturalPersonData: { firstName, secondName, firstSurname, secondSurname },
            }),
          })
        }
      } catch (authErr) {
        console.warn('[UpdateProfile] Failed to sync with Authoriza:', (authErr as Error).message)
      }
    }

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
// La distribución usa el PRESUPUESTO TOTAL ACUMULADO (cashBalance + monto nuevo)
// como base, NO el ingreso mensual. Así la billetera tiene su propia distribución
// separada de Proyecciones.

router.post('/wallet/income', walletLimiter, validate(walletIncomeSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo } = req.body as { monto: number; tipo: 'salario' | 'extra' }

    // Obtener datos del usuario: cashBalance actual para calcular nuevo presupuesto total
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true },
    })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    // Obtener TODAS las obligaciones activas (totales mensuales)
    const [debts, fixedExpenses] = await Promise.all([
      prisma.debt.findMany({ where: { userId, estado: 'activa' }, select: { cuotaPeriodo: true } }),
      prisma.fixedExpense.findMany({ where: { userId }, select: { monto: true } }),
    ])

    // ═══ PRESUPUESTO TOTAL = cashBalance actual + nuevo ingreso ═══
    const currentCashBalance = Number(user.cashBalance) || 0
    const newBudgetTotal = currentCashBalance + monto

    const totalObligationsMonthly = debts.reduce((s, d) => s + Number(d.cuotaPeriodo), 0) +
                                    fixedExpenses.reduce((s, f) => s + Number(f.monto), 0)

    // Base para la distribución: el presupuesto total acumulado en la billetera
    const baseIncome = newBudgetTotal

    // ═══ DISTRIBUCIÓN INTELIGENTE — El Embudo (basada en presupuesto total) ═══
    const obligationsPct = (totalObligationsMonthly / baseIncome) * 100
    const isOverloaded = totalObligationsMonthly >= baseIncome

    let aObligaciones: number
    let aAhorro: number
    let aLibre: number
    let aEndeudamiento: number

    if (isOverloaded) {
      // Estado CRÍTICO: obligaciones superan o igualan el presupuesto total → todo va a obligaciones
      aObligaciones = monto
      aAhorro = 0
      aLibre = 0
      aEndeudamiento = 0
    } else {
      const remanente = baseIncome - totalObligationsMonthly
      const remanentePct = (remanente / baseIncome) * 100

      // Ahorro: escala según presión del presupuesto
      let savingsPct: number
      if (remanentePct >= 40) savingsPct = 20
      else if (remanentePct >= 25) savingsPct = 15
      else if (remanentePct >= 15) savingsPct = 10
      else savingsPct = 5

      // El ahorro NO puede superar el remanente real
      const targetSavingsAmount = (savingsPct / 100) * baseIncome
      const savingsAmount = Math.min(targetSavingsAmount, remanente)

      // Lo que queda tras ahorro
      const afterSavings = remanente - savingsAmount

      // Gasto libre: tope 15% del presupuesto total, pero limitado por lo disponible
      const maxDailyFreeAmount = (15 / 100) * baseIncome
      let dailyFreeAmount: number
      let debtCapacityAmount: number

      if (afterSavings <= maxDailyFreeAmount) {
        dailyFreeAmount = Math.max(0, afterSavings)
        debtCapacityAmount = 0
      } else {
        dailyFreeAmount = maxDailyFreeAmount
        debtCapacityAmount = afterSavings - maxDailyFreeAmount
      }

      // Convertir montos del embudo a proporciones del monto REAL registrado
      const totalDistrib = totalObligationsMonthly + savingsAmount + dailyFreeAmount + debtCapacityAmount
      if (totalDistrib > 0) {
        aObligaciones = Math.round((totalObligationsMonthly / totalDistrib) * monto * 100) / 100
        aAhorro = Math.round((savingsAmount / totalDistrib) * monto * 100) / 100
        aLibre = Math.round((dailyFreeAmount / totalDistrib) * monto * 100) / 100
        aEndeudamiento = Math.round((monto - aObligaciones - aAhorro - aLibre) * 100) / 100
      } else {
        aObligaciones = monto
        aAhorro = 0
        aLibre = 0
        aEndeudamiento = 0
      }
    }

    // Asegurar que no haya negativos por redondeo
    aEndeudamiento = Math.max(0, aEndeudamiento)

    console.log('[WalletIncome] Distribución:', { baseIncome: newBudgetTotal, obligationsPct: Math.round(obligationsPct), isOverloaded, aObligaciones, aAhorro, aLibre, aEndeudamiento, monto })

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

    // Push notification de confirmación (no bloquea la respuesta)
    sendPushToUser(userId, {
      title: tipo === 'salario' ? '💰 Sueldo registrado' : '💸 Ingreso extra registrado',
      body: `Se distribuyeron $${monto.toLocaleString('es-CO')} en tu billetera inteligente.`,
      tag: 'income-registered',
      url: '/gestion',
    }).catch(() => {})
  } catch (error) {
    console.error('[WalletIncome]', error)
    res.status(500).json({ error: 'Error al registrar ingreso' })
  }
})

// ─── POST /users/wallet/deduct ────────────────────────────────────────────────
// Deduce un monto de un bolsillo específico (obligaciones o libre)

router.post('/wallet/deduct', walletLimiter, validate(walletDeductSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, bolsillo } = req.body as { monto: number; bolsillo: 'obligaciones' | 'libre' | 'ahorro' }

    const field = bolsillo === 'obligaciones' ? 'walletObligaciones'
                : bolsillo === 'ahorro' ? 'walletAhorro'
                : 'walletLibre'

    // Verificar que hay suficiente saldo antes de deducir
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true, walletObligaciones: true, walletLibre: true, walletAhorro: true },
    })
    if (!current) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    const currentPocket = Number(current[field])
    const currentCash = Number(current.cashBalance)

    // No permitir deducir más de lo disponible en el bolsillo
    const deductAmount = Math.min(monto, Math.max(0, currentPocket))
    const deductCash = Math.min(monto, Math.max(0, currentCash))

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        cashBalance: { decrement: deductCash },
        [field]: { decrement: deductAmount },
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
        cashBalance: Math.max(0, Number(user.cashBalance)),
        ahorro: Math.max(0, Number(user.walletAhorro)),
        obligaciones: Math.max(0, Number(user.walletObligaciones)),
        libre: Math.max(0, Number(user.walletLibre)),
        endeudamiento: Math.max(0, Number(user.walletEndeudamiento)),
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

// ─── POST /users/push-subscription ────────────────────────────────────────────
// Guarda la suscripción push del navegador del usuario

router.post('/push-subscription', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { subscription } = req.body as { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      res.status(400).json({ error: 'Suscripción inválida' })
      return
    }

    // Upsert: si ya existe el endpoint, actualizar
    await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      update: { userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      create: { userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    })

    res.json({ message: 'Suscripción guardada' })
  } catch (error) {
    console.error('[PushSubscription]', error)
    res.status(500).json({ error: 'Error al guardar suscripción' })
  }
})

export default router
