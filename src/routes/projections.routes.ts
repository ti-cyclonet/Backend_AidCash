import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { z } from 'zod'
import { validate } from '../middleware/validate.js'
import { requireFeature } from '../middleware/limit-enforcement.js'
import { otorgarInsigniaPro } from '../lib/planes.js'

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

// ─── GET /projections/movimientos — base de la pestaña Proyecciones ──────────
// Gastos (sin los pagados con tarjeta: ya están en su cuota) y ahorros de los
// últimos ~4 meses, para que el frontend saque promedios mensuales REALES.
// (La lista de /impulse-expenses solo trae el periodo actual — con ella el
// promedio de gasto variable salía casi en cero.)

router.get('/movimientos', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const desde = new Date(Date.now() - 120 * 86400000)
    const [gastos, ahorros] = await Promise.all([
      prisma.impulseExpense.findMany({
        where: { userId, tarjetaId: null, createdAt: { gte: desde } },
        select: { monto: true, createdAt: true, esHormiga: true },
      }),
      prisma.savingsHistory.findMany({
        where: { userId, tipo: 'ahorro', createdAt: { gte: desde } },
        select: { monto: true, createdAt: true },
      }),
    ])
    res.json({
      gastos: gastos.map(g => ({ monto: Number(g.monto), fecha: g.createdAt, hormiga: g.esHormiga })),
      ahorros: ahorros.map(a => ({ monto: Number(a.monto), fecha: a.createdAt })),
    })
  } catch (error) {
    console.error('[ProjectionsMovimientos]', error)
    res.status(500).json({ error: 'Error al cargar los movimientos' })
  }
})

// ─── Escenarios guardados de Proyecciones (KIRI PRO) ──────────────────────────

const escenarioSchema = z.object({
  nombre: z.string().trim().min(1).max(60),
  aporteExtra: z.number().min(0).max(1_000_000_000),
  recortarHormiga: z.boolean().default(false),
  meses: z.number().int().min(1).max(24).default(12),
}).strict()

const serializarEscenario = (e: { id: string; nombre: string; aporteExtra: unknown; recortarHormiga: boolean; meses: number; createdAt: Date }) =>
  ({ id: e.id, nombre: e.nombre, aporteExtra: Number(e.aporteExtra), recortarHormiga: e.recortarHormiga, meses: e.meses, createdAt: e.createdAt })

router.get('/escenarios', async (req: Request, res: Response): Promise<void> => {
  try {
    const rows = await prisma.proyeccionEscenario.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'desc' } })
    res.json({ escenarios: rows.map(serializarEscenario) })
  } catch (error) {
    console.error('[Escenarios]', error)
    res.status(500).json({ error: 'Error al cargar los escenarios' })
  }
})

router.post('/escenarios', requireFeature('savedScenarios'), validate(escenarioSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const total = await prisma.proyeccionEscenario.count({ where: { userId } })
    if (total >= 20) { res.status(400).json({ error: 'Tienes 20 escenarios guardados: borra alguno para guardar otro.' }); return }
    const d = req.body as z.infer<typeof escenarioSchema>
    const e = await prisma.proyeccionEscenario.create({ data: { userId, nombre: d.nombre, aporteExtra: d.aporteExtra, recortarHormiga: d.recortarHormiga, meses: d.meses } })
    otorgarInsigniaPro(userId, 'pro_estratega')
    res.status(201).json({ escenario: serializarEscenario(e) })
  } catch (error) {
    console.error('[EscenarioCrear]', error)
    res.status(500).json({ error: 'Error al guardar el escenario' })
  }
})

router.delete('/escenarios/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await prisma.proyeccionEscenario.deleteMany({ where: { id: String(req.params.id), userId: req.user!.userId } })
    if (r.count === 0) { res.status(404).json({ error: 'Escenario no encontrado' }); return }
    res.json({ message: 'Escenario eliminado' })
  } catch (error) {
    console.error('[EscenarioBorrar]', error)
    res.status(500).json({ error: 'Error al eliminar el escenario' })
  }
})

export default router
