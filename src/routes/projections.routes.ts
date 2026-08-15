import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Projections Routes — Análisis predictivo de gasto
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Endpoint on-demand para que el frontend pueda mostrar proyecciones
 * de gasto en la UI sin esperar al cron diario.
 */

// ─── GET /projections/spending — Proyección de gasto actual del usuario ───────

router.get('/spending', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        walletLibre: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletEndeudamiento: true,
        diasPago: true,
        frecuenciaIngreso: true,
        ingresoBase: true,
      },
    })

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }

    const now = new Date()
    const today = now.getDate()
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()

    // Rangos
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Gastos hormiga por periodos
    const [spendingWeek, spendingLastWeek, spendingMonth] = await Promise.all([
      prisma.impulseExpense.aggregate({
        where: { userId, createdAt: { gte: sevenDaysAgo } },
        _sum: { monto: true },
        _count: true,
      }),
      prisma.impulseExpense.aggregate({
        where: { userId, createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
        _sum: { monto: true },
        _count: true,
      }),
      prisma.impulseExpense.aggregate({
        where: { userId, createdAt: { gte: thirtyDaysAgo } },
        _sum: { monto: true },
        _count: true,
      }),
    ])

    const weekTotal = Number(spendingWeek._sum.monto ?? 0)
    const lastWeekTotal = Number(spendingLastWeek._sum.monto ?? 0)
    const monthTotal = Number(spendingMonth._sum.monto ?? 0)

    const dailyAvg7d = weekTotal / 7
    const dailyAvg14d = (weekTotal + lastWeekTotal) / 14
    const dailyAvg30d = monthTotal / 30

    const walletLibre = Number(user.walletLibre)

    // Días restantes a ritmo actual
    const diasRestantes7d = dailyAvg7d > 0 ? walletLibre / dailyAvg7d : Infinity
    const diasRestantes30d = dailyAvg30d > 0 ? walletLibre / dailyAvg30d : Infinity

    // Días hasta próximo pago
    let diasHastaPago = 30
    if (user.diasPago.length > 0) {
      let min = Infinity
      for (const payday of user.diasPago) {
        const d = payday >= today ? payday - today : (daysInMonth - today) + payday
        if (d > 0 && d < min) min = d
      }
      diasHastaPago = min === Infinity ? 30 : min
    }

    // Tendencia: comparar semana actual vs anterior
    let tendencia: 'estable' | 'creciente' | 'decreciente' = 'estable'
    if (lastWeekTotal > 0) {
      const change = (weekTotal - lastWeekTotal) / lastWeekTotal
      if (change > 0.2) tendencia = 'creciente'
      else if (change < -0.2) tendencia = 'decreciente'
    }

    // Nivel de riesgo
    let riesgo: 'bajo' | 'medio' | 'alto' | 'critico' = 'bajo'
    if (diasRestantes7d <= 2 || (diasRestantes7d < diasHastaPago && diasRestantes7d <= 5)) {
      riesgo = 'critico'
    } else if (diasRestantes7d <= 5) {
      riesgo = 'alto'
    } else if (diasRestantes7d <= 10 || tendencia === 'creciente') {
      riesgo = 'medio'
    }

    // Recomendación basada en el análisis
    let recomendacion = ''
    if (riesgo === 'critico') {
      recomendacion = 'Tu wallet libre se agotará pronto. Evita gastos innecesarios hoy y considera transferir fondos de ahorro si es urgente.'
    } else if (riesgo === 'alto') {
      recomendacion = 'Tu ritmo de gasto es elevado. Intenta reducir gastos hormiga los próximos días para llegar bien a tu próximo pago.'
    } else if (riesgo === 'medio') {
      recomendacion = 'Tu gasto está en un rango moderado. Mantén el control y revisa si puedes reducir algún gasto recurrente.'
    } else {
      recomendacion = 'Vas bien. Tu ritmo de gasto es sostenible para el periodo actual.'
    }

    // Monto diario recomendado para llegar al próximo pago
    const presupuestoDiarioRecomendado = diasHastaPago > 0 ? walletLibre / diasHastaPago : 0

    res.json({
      projection: {
        walletLibre,
        gastoPromediodiario7d: Math.round(dailyAvg7d),
        gastoPromediodiario30d: Math.round(dailyAvg30d),
        diasRestantes: Math.ceil(diasRestantes7d),
        diasHastaPago,
        presupuestoDiarioRecomendado: Math.round(presupuestoDiarioRecomendado),
        diferencia: Math.round(presupuestoDiarioRecomendado - dailyAvg7d),
        tendencia,
        riesgo,
        recomendacion,
        stats: {
          gastoSemanaActual: Math.round(weekTotal),
          gastoSemanaAnterior: Math.round(lastWeekTotal),
          gastoMes: Math.round(monthTotal),
          transaccionesSemana: spendingWeek._count,
          transaccionesMes: spendingMonth._count,
        },
      },
    })
  } catch (error) {
    console.error('[Projections:Spending]', error)
    res.status(500).json({ error: 'Error al calcular proyecciones de gasto' })
  }
})

export default router
