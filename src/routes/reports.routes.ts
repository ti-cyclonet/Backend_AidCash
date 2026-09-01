import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from '../lib/period.js'
import { generarTablaAmortizacion } from '../lib/amortization.js'

const router = Router()
router.use(authMiddleware)

// Frontera Q1/Q2 de una obligación quincenal: sus PROPIOS días de cobro, no
// los del sueldo del usuario — ver nota en debts.routes.ts.
function itemPeriodo(frecuencia: string, ownDays: string): string {
  if (frecuencia !== 'quincenal') return getPeriodo(frecuencia)
  return getPeriodo('quincenal', parseDiasPago(ownDays))
}

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
      debtPayments,
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

      // Historial de pagos de deuda con amortización (periodo actual)
      prisma.debtPayment.findMany({
        where: {
          debt: { userId },
          createdAt: { gte: from, lte: to },
        },
        include: { debt: { select: { nombre: true, acreedor: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // Historial de pagos de gastos fijos dentro del rango (ledger, mismo patrón que debtPayments)
    const fixedExpensePayments = await prisma.fixedExpensePayment.findMany({
      where: { fixedExpense: { userId }, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'desc' },
    })

    // ── Totales para el balance ─────────────────────────────────────────────────

    const totalImpulse = impulseExpenses.reduce((s, e) => s + Number(e.monto), 0)
    const totalSaved   = savingsHistory.filter(e => e.tipo === 'ahorro').reduce((s, e) => s + Number(e.monto), 0)
    const totalExtra   = extraIncomes.reduce((s, e) => s + Number(e.monto), 0)
    // Deudas y fijos EFECTIVAMENTE PAGADOS dentro del rango — se toma del ledger
    // de pagos (montoPagado real), no de una columna "pagado" que ya no existe.
    const totalDebts   = debtPayments.reduce((s, p) => s + Number(p.montoPagado), 0)
    const totalFixed   = fixedExpensePayments.reduce((s, p) => s + Number(p.montoPagado), 0)

    // ── Amortización: intereses pagados vs capital abonado ────────────────────
    const totalInteresPagado = debtPayments.reduce((s, p) => s + Number(p.pagoInteres), 0)
    const totalCapitalAbonado = debtPayments.reduce((s, p) => s + Number(p.abonoCapital), 0)
    const totalPagosDeuda = debtPayments.reduce((s, p) => s + Number(p.montoPagado), 0)

    // Intereses ahorrados: si el usuario paga más de la cuota mínima, ahorra intereses futuros
    // Cálculo simplificado: por cada peso extra abonado al capital, se evita pagar interés sobre ese peso
    const allDebtPaymentsEver = await prisma.debtPayment.aggregate({
      where: { debt: { userId } },
      _sum: { pagoInteres: true, abonoCapital: true, montoPagado: true },
    })
    const totalInteresHistorico = Number(allDebtPaymentsEver._sum.pagoInteres ?? 0)
    const totalCapitalHistorico = Number(allDebtPaymentsEver._sum.abonoCapital ?? 0)

    // ── Interés evitado: cuánto interés te ahorraste pagando más que el mínimo ──
    // Por deuda: interés total SI solo se hubieran hecho pagos mínimos (tabla de
    // amortización completa desde el monto inicial) vs interés real proyectado
    // (lo ya pagado + lo que falta proyectado desde el saldo ACTUAL, que es menor
    // porque hubo abonos extra). La diferencia es interés que ya no se pagará.
    const interesPorDeuda = await prisma.debtPayment.groupBy({
      by: ['debtId'],
      where: { debt: { userId } },
      _sum: { pagoInteres: true },
    })
    const interesPagadoPorDeuda = new Map(interesPorDeuda.map(r => [r.debtId, Number(r._sum.pagoInteres ?? 0)]))

    let interesEvitado = 0
    for (const d of debts) {
      const tasa = d.tasaInteresAplicada ? Number(d.tasaInteresAplicada) : (d.tasaInteres ? Number(d.tasaInteres) : null)
      if (!tasa || tasa <= 0) continue
      const cuota = Number(d.cuotaPeriodo)
      if (!cuota || cuota <= 0) continue

      const montoInicial = Number(d.montoInicial ?? d.montoTotal)
      const interesOriginalTotal = generarTablaAmortizacion(montoInicial, tasa, cuota)
        .reduce((s, r) => s + r.pagoInteres, 0)

      const interesYaPagado = interesPagadoPorDeuda.get(d.id) ?? 0
      const saldoActual = Number(d.saldoRestante)
      const interesRestanteProyectado = saldoActual > 0
        ? generarTablaAmortizacion(saldoActual, tasa, cuota).reduce((s, r) => s + r.pagoInteres, 0)
        : 0
      const interesProyectadoActual = interesYaPagado + interesRestanteProyectado

      interesEvitado += Math.max(0, interesOriginalTotal - interesProyectadoActual)
    }
    interesEvitado = Math.round(interesEvitado)

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
    // totalEgreso: lo que realmente se ha pagado/gastado en el periodo
    const totalFixedPaid = totalFixed
    const totalEgreso  = totalPagosDeuda + totalFixedPaid + totalImpulse

    // Totales históricos (toda la vida)
    const totalIngresosHistorico = Number(incomeRecordsAll._sum.monto ?? 0)
    // Egresos históricos: suma de todos los pagos de deuda + impulse + gastos fijos pagados
    const allImpulseEver = await prisma.impulseExpense.aggregate({ where: { userId }, _sum: { monto: true } })
    const allDebtPaymentsTotal = Number(allDebtPaymentsEver._sum.montoPagado ?? 0)
    const totalEgresosHistorico = allDebtPaymentsTotal + totalFixedPaid + Number(allImpulseEver._sum.monto ?? 0)

    // ── Distribución por categoría (para pie chart) ───────────────────────────
    const categoryDistribution = [
      { name: 'Deudas',          value: totalDebts,   color: '#8096E6' },
      { name: 'Gastos Fijos',    value: totalFixed,   color: '#A2D2FF' },
      { name: 'Gastos Hormiga',  value: totalImpulse, color: '#FFB3C6' },
      { name: 'Ahorro',          value: totalSaved,   color: '#B9FBC0' },
    ].filter(c => c.value > 0)

    // ── Serie temporal de ingresos vs egresos (para chart) ─────────────────
    // Granularidad dinámica según timeframe
    const getKey = (date: Date): string => {
      switch (timeframe) {
        case 'week':
          // Por día: "lun 14", "mar 15"...
          return date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' })
        case 'month':
          // Por día: "1 jul", "2 jul"...
          return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
        case 'year':
          // Por mes: "ene 2026", "feb 2026"...
          return date.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })
        case 'all':
        default:
          return date.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })
      }
    }

    const timeMap: Record<string, { ingresos: number; egresos: number; ts: number }> = {}

    const addToMonth = (date: Date, type: 'ingresos' | 'egresos', amount: number) => {
      const key = getKey(date)
      if (!timeMap[key]) timeMap[key] = { ingresos: 0, egresos: 0, ts: date.getTime() }
      timeMap[key][type] += amount
    }

    // Egresos
    impulseExpenses.forEach(e => addToMonth(new Date(e.createdAt), 'egresos', Number(e.monto)))
    debtPayments.forEach(p => addToMonth(new Date(p.createdAt), 'egresos', Number(p.montoPagado)))
    // Gastos fijos pagados — fecha real de cada pago del ledger, no `updatedAt`
    // de la fila (que se mueve con cualquier PATCH, no solo con un pago)
    fixedExpensePayments.forEach(p => addToMonth(new Date(p.createdAt), 'egresos', Number(p.montoPagado)))

    // Ingresos reales registrados
    const incomeRecordsPeriodList = await prisma.incomeRecord.findMany({
      where: { userId, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'desc' },
    })
    incomeRecordsPeriodList.forEach(r => addToMonth(new Date(r.createdAt), 'ingresos', Number(r.monto)))
    extraIncomes.forEach(e => addToMonth(new Date(e.createdAt), 'ingresos', Number(e.monto)))

    const monthlySeries = Object.entries(timeMap)
      .map(([month, vals]) => ({ month, ingresos: vals.ingresos, egresos: vals.egresos, ts: vals.ts }))
      .sort((a, b) => a.ts - b.ts)
      .map(({ month, ingresos, egresos }) => ({ month, ingresos, egresos }))

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
        totalFixedPaid,
        totalImpulse,
        totalSaved,
        cashBalance: Number(user?.cashBalance ?? 0),
        frecuenciaIngreso: user?.frecuenciaIngreso ?? 'mensual',
        // Amortización
        totalInteresPagado,
        totalCapitalAbonado,
        totalPagosDeuda,
        totalInteresHistorico,
        totalCapitalHistorico,
        interesEvitado,
      },

      // Para charts
      categoryDistribution,
      monthlySeries,

      // Listas detalladas para la tabla y exportación
      impulseExpenses:  impulseExpenses.map(e => ({ ...e, monto: Number(e.monto) })),
      savingsHistory:   savingsHistory.map(e => ({ ...e, monto: Number(e.monto) })),
      extraIncomes:     extraIncomes.map(e => ({ ...e, monto: Number(e.monto) })),
      debts: debts.map(d => {
        const periodo = itemPeriodo(d.frecuenciaPago === 'quincenal' ? 'quincenal' : 'mensual', d.diasPago)
        const paid = debtPayments.filter(p => p.debtId === d.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
        return {
          ...d,
          montoTotal: Number(d.montoTotal),
          cuotaPeriodo: Number(d.cuotaPeriodo),
          pagadoEstePeriodo: paid >= Number(d.cuotaPeriodo),
          montoPagadoEstePeriodo: paid > 0 ? paid : null,
        }
      }),
      fixedExpenses: fixedExpenses.map(f => {
        const periodo = itemPeriodo(f.frecuencia, f.fechaCorte)
        const montoPorPeriodo = getMontoPorPeriodo(Number(f.monto), f.frecuencia)
        const paid = fixedExpensePayments.filter(p => p.fixedExpenseId === f.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
        return {
          ...f,
          monto: Number(f.monto),
          pagadoEstePeriodo: paid >= montoPorPeriodo,
          montoPagadoEstePeriodo: paid > 0 ? paid : null,
        }
      }),

      // Historial de amortización
      debtPayments: debtPayments.map(p => ({
        id: p.id,
        debtName: p.debt.nombre,
        acreedor: p.debt.acreedor,
        montoPagado: Number(p.montoPagado),
        abonoCapital: Number(p.abonoCapital),
        pagoInteres: Number(p.pagoInteres),
        saldoAnterior: Number(p.saldoAnterior),
        saldoPosterior: Number(p.saldoPosterior),
        periodo: p.periodo,
        createdAt: p.createdAt,
      })),

      // Ingresos registrados (sueldo + extras)
      incomeRecords: incomeRecordsPeriodList.map(r => ({ ...r, monto: Number(r.monto) })),
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
