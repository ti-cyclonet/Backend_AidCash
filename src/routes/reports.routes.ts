import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// ─── Helpers de rango de fechas ───────────────────────────────────────────────

type Timeframe = 'week' | 'month' | 'year' | 'all'

function getDateRange(timeframe: Timeframe): { from: Date; to: Date } {
  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)

  const from = new Date(now)
  from.setHours(0, 0, 0, 0)

  switch (timeframe) {
    case 'week':
      from.setDate(now.getDate() - 6)      // últimos 7 días
      break
    case 'month':
      from.setDate(1)                       // primer día del mes actual
      break
    case 'year':
      from.setMonth(0, 1)                   // 1 de enero del año actual
      break
    case 'all':
      from.setFullYear(2000, 0, 1)          // todo el historial
      break
  }

  return { from, to }
}

// ─── GET /reports/balance  ────────────────────────────────────────────────────
// Devuelve todos los datos de historial filtrados por timeframe
// Query: ?timeframe=week|month|year|all  (default: month)

router.get('/balance', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const rawTimeframe = req.query.timeframe as string
    const validTimeframes: Timeframe[] = ['week', 'month', 'year', 'all']
    const timeframe: Timeframe = validTimeframes.includes(rawTimeframe as Timeframe)
      ? (rawTimeframe as Timeframe)
      : 'month'
    const { from, to } = getDateRange(timeframe)

    const [
      impulseExpenses,
      savingsHistory,
      extraIncomes,
      debts,
      fixedExpenses,
      user,
      incomeRecordsAll,
    ] = await Promise.all([
      // Gastos hormiga — filtrados por createdAt
      prisma.impulseExpense.findMany({
        where: { userId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
      }),

      // Historial de ahorro — filtrado por createdAt
      prisma.savingsHistory.findMany({
        where: { userId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
      }),

      // Ingresos extra — filtrados por createdAt
      prisma.extraIncome.findMany({
        where: { userId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
      }),

      // Deudas — todas las activas + las saldadas en el rango
      prisma.debt.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),

      // Gastos fijos — todos
      prisma.fixedExpense.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),

      // Ingreso base del usuario
      prisma.user.findUnique({
        where: { id: userId },
        select: { ingresoBase: true, frecuenciaIngreso: true, cashBalance: true },
      }),

      // Total de ingresos reales registrados (toda la vida)
      prisma.incomeRecord.aggregate({
        where: { userId },
        _sum: { monto: true },
      }),
    ])

    // ── Totales para el balance ─────────────────────────────────────────────────

    const totalImpulse = impulseExpenses.reduce((s, e) => s + Number(e.monto), 0)
    const totalSaved   = savingsHistory.filter(e => e.tipo === 'ahorro').reduce((s, e) => s + Number(e.monto), 0)
    const totalExtra   = extraIncomes.reduce((s, e) => s + Number(e.monto), 0)
    // Deudas y fijos pagados EN ESTE PERIODO (marcados como pagado)
    const totalDebts   = debts.filter(d => d.pagadoEstePeriodo).reduce((s, d) => s + Number(d.cuotaPeriodo), 0)
    const totalFixed   = fixedExpenses.filter(f => f.pagadoEstePeriodo).reduce((s, f) => s + Number(f.monto), 0)

    // Ingreso REAL del periodo = lo que el usuario ha registrado en income_records dentro del rango
    // Si no hay registros en el periodo, usamos ingresoBase como referencia
    const ingresoBase = Number(user?.ingresoBase ?? 0)

    // Consultar ingresos reales registrados DENTRO del periodo
    const incomeRecordsPeriod = await prisma.incomeRecord.aggregate({
      where: { userId, createdAt: { gte: from, lte: to } },
      _sum: { monto: true },
    })
    const ingresosRealPeriodo = Number(incomeRecordsPeriod._sum.monto ?? 0)

    // totalIngreso: si hay registros reales en el periodo, usar esos. Si no, usar base + extra.
    const totalIngreso = ingresosRealPeriodo > 0 ? ingresosRealPeriodo + totalExtra : ingresoBase + totalExtra
    // totalEgreso: solo lo que realmente se ha gastado (pagado + hormiga). Ahorro NO es egreso.
    const totalEgreso  = totalDebts + totalFixed + totalImpulse

    // Totales históricos (toda la vida)
    const totalIngresosHistorico = Number(incomeRecordsAll._sum.monto ?? 0)
    // Egresos históricos: necesitamos sumar TODOS los pagados históricamente + todos los impulse
    const allImpulseEver = await prisma.impulseExpense.aggregate({ where: { userId }, _sum: { monto: true } })
    const totalEgresosHistorico = totalDebts + totalFixed + Number(allImpulseEver._sum.monto ?? 0)

    // ── Distribución por categoría (para pie chart) ───────────────────────────
    const categoryDistribution = [
      { name: 'Deudas',          value: totalDebts,   color: '#8096E6' },
      { name: 'Gastos Fijos',    value: totalFixed,   color: '#A2D2FF' },
      { name: 'Gastos Hormiga',  value: totalImpulse, color: '#FFB3C6' },
      { name: 'Ahorro',          value: totalSaved,   color: '#B9FBC0' },
    ].filter(c => c.value > 0)

    // ── Serie mensual de ingresos vs egresos (para bar chart) ─────────────────
    // Agrupa los gastos hormiga por mes para la barra comparativa
    const monthlyMap: Record<string, { ingresos: number; egresos: number }> = {}

    const addToMonth = (date: Date, type: 'ingresos' | 'egresos', amount: number) => {
      const key = date.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })
      if (!monthlyMap[key]) monthlyMap[key] = { ingresos: 0, egresos: 0 }
      monthlyMap[key][type] += amount
    }

    impulseExpenses.forEach(e => addToMonth(new Date(e.createdAt), 'egresos', Number(e.monto)))
    savingsHistory.forEach(e => addToMonth(new Date(e.createdAt), 'egresos', Number(e.monto)))
    extraIncomes.forEach(e => addToMonth(new Date(e.createdAt), 'ingresos', Number(e.monto)))

    const monthlySeries = Object.entries(monthlyMap)
      .map(([month, vals]) => ({ month, ...vals }))
      .sort((a, b) => new Date('1 ' + a.month).getTime() - new Date('1 ' + b.month).getTime())

    res.json({
      timeframe,
      from: from.toISOString(),
      to: to.toISOString(),

      // Totales
      summary: {
        totalIngreso,
        totalEgreso,
        ingresoBase,
        totalIngresosHistorico,
        totalEgresosHistorico,
        totalExtra,
        totalDebts,
        totalFixed,
        totalImpulse,
        totalSaved,
        cashBalance: Number(user?.cashBalance ?? 0),
        frecuenciaIngreso: user?.frecuenciaIngreso ?? 'mensual',
      },

      // Para charts
      categoryDistribution,
      monthlySeries,

      // Listas detalladas para la tabla y exportación
      impulseExpenses:  impulseExpenses.map(e => ({ ...e, monto: Number(e.monto) })),
      savingsHistory:   savingsHistory.map(e => ({ ...e, monto: Number(e.monto) })),
      extraIncomes:     extraIncomes.map(e => ({ ...e, monto: Number(e.monto) })),
      debts:            debts.map(d => ({ ...d, montoTotal: Number(d.montoTotal), cuotaPeriodo: Number(d.cuotaPeriodo), montoPagadoEstePeriodo: d.montoPagadoEstePeriodo ? Number(d.montoPagadoEstePeriodo) : null })),
      fixedExpenses:    fixedExpenses.map(f => ({ ...f, monto: Number(f.monto) })),

      // Ingresos registrados (sueldo + extras)
      incomeRecords: await prisma.incomeRecord.findMany({
        where: { userId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
      }).then(records => records.map(r => ({ ...r, monto: Number(r.monto) }))),
    })
  } catch (error) {
    console.error('[BalanceReport]', error)
    res.status(500).json({ error: 'Error al obtener el balance' })
  }
})

// ─── DELETE /reports/income-records/:id ────────────────────────────────────────
// Elimina un registro de ingreso del historial

router.delete('/income-records/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const existing = await prisma.incomeRecord.findFirst({ where: { id, userId } })
    if (!existing) { res.status(404).json({ error: 'Registro no encontrado' }); return }
    await prisma.incomeRecord.delete({ where: { id } })
    res.json({ message: 'Registro eliminado' })
  } catch (error) {
    console.error('[DeleteIncomeRecord]', error)
    res.status(500).json({ error: 'Error al eliminar registro' })
  }
})

// ─── POST /reports/reset-history ──────────────────────────────────────────────
// Borra todo el historial detallado (ingresos, ahorro, impulse) SIN tocar el wallet/cashBalance

router.post('/reset-history', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    await prisma.$transaction([
      prisma.incomeRecord.deleteMany({ where: { userId } }),
      prisma.savingsHistory.deleteMany({ where: { userId } }),
      prisma.impulseExpense.deleteMany({ where: { userId } }),
    ])

    res.json({ message: 'Historial reiniciado correctamente' })
  } catch (error) {
    console.error('[ResetHistory]', error)
    res.status(500).json({ error: 'Error al reiniciar historial' })
  }
})

export default router
