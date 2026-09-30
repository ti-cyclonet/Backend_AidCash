import { Router, Request, Response } from 'express'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { resolverPlan, inicioHistorial, mejoraPara } from '../lib/planes.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from '../lib/period.js'
import { generarTablaAmortizacion } from '../lib/amortization.js'
import { cuotaBaseDelPeriodo, tasaDelPeriodo } from '../lib/debt-calc.js'

const router = Router()
router.use(authMiddleware)

// Frontera Q1/Q2 de una obligación quincenal: sus PROPIOS días de cobro, no
// los del sueldo del usuario — ver nota en debts.routes.ts.
function itemPeriodo(frecuencia: string, ownDays: string): string {
  if (frecuencia !== 'quincenal') return getPeriodo(frecuencia)
  return getPeriodo('quincenal', parseDiasPago(ownDays))
}

// ─── Helpers de rango de fechas ───────────────────────────────────────────────

type Timeframe = 'week' | 'month' | 'year' | 'all' | 'custom'

/**
 * `custom` + `customFrom`/`customTo` válidos permite pedir el balance de UN
 * mes específico (o cualquier rango) en vez de solo "el mes actual" — antes
 * el export a PDF por mes elegido no tenía forma de pedirle esto al backend,
 * así que siempre terminaba trayendo los datos del mes/año calendario ACTUAL
 * sin importar qué mes hubiera elegido el usuario.
 */
function getDateRange(timeframe: Timeframe, customFrom?: string, customTo?: string): { from: Date; to: Date } {
  if (timeframe === 'custom' && customFrom && customTo) {
    // "AAAA-MM-DD" se interpreta como fecha LOCAL: new Date("2026-09-01") es
    // medianoche UTC, que en Colombia es el 31 de agosto a las 7 p. m. — el
    // rango arrancaba un día antes y metía movimientos del mes anterior.
    const aFechaLocal = (s: string) => {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
    }
    const from = aFechaLocal(customFrom)
    const to = aFechaLocal(customTo)
    from.setHours(0, 0, 0, 0)
    to.setHours(23, 59, 59, 999)
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && from <= to) return { from, to }
    // Fechas inválidas: caer al comportamiento de "month" en vez de fallar.
  }

  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)

  const from = new Date(now)
  from.setHours(0, 0, 0, 0)

  switch (timeframe) {
    case 'week':
      from.setDate(now.getDate() - 6)      // últimos 7 días
      break
    case 'year':
      from.setMonth(0, 1)                   // 1 de enero del año actual
      break
    case 'all':
      from.setFullYear(2000, 0, 1)          // todo el historial
      break
    case 'month':
    case 'custom':
    default:
      from.setDate(1)                       // primer día del mes actual
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
    const validTimeframes: Timeframe[] = ['week', 'month', 'year', 'all', 'custom']
    const timeframe: Timeframe = validTimeframes.includes(rawTimeframe as Timeframe)
      ? (rawTimeframe as Timeframe)
      : 'month'
    const rango = getDateRange(timeframe, req.query.from as string | undefined, req.query.to as string | undefined)
    let from = rango.from
    const to = rango.to

    // Historial según el plan: FREE 3 meses, PLUS 24, PRO sin límite
    const plan = await resolverPlan(userId)
    const mesesHistorial = plan.limites.mesesHistorial?.maxValue ?? 3
    const inicioPermitido = plan.fuente === 'sin_conexion' ? null : inicioHistorial(mesesHistorial)
    let historialLimitado: { meses: number; desde: string; plan: string; mejora: ReturnType<typeof mejoraPara> } | null = null
    if (inicioPermitido && from < inicioPermitido) {
      from = inicioPermitido
      historialLimitado = { meses: mesesHistorial, desde: inicioPermitido.toISOString(), plan: plan.planName, mejora: mejoraPara('mesesHistorial', plan.tier) }
    }

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
        include: { tarjeta: { select: { nombre: true } } },
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
        include: {
          debt: { select: { nombre: true, acreedor: true, tipoDeuda: true } },
          tarjeta: { select: { nombre: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // Historial de pagos de gastos fijos dentro del rango (ledger, mismo patrón que
    // debtPayments) — antes solo se usaba para sumar el total, nunca se exponía
    // como lista propia, así que la UI reconstruía la tabla de "Detalle de
    // transacciones" a partir de fixedExpenses.pagadoEstePeriodo (calculado
    // siempre contra el periodo ACTUAL, sin importar el rango pedido) en vez de
    // este ledger real acotado por from/to.
    //
    // Todas las demás consultas son independientes entre sí: van en paralelo.
    // Antes eran ~10 esperas seguidas y, en la prueba de carga (50 usuarios a la
    // vez, ~350 mil filas), Balance tardaba 1,2–1,5 s.
    const [
      fixedExpensePayments,
      [externalLoansPeriod, externalPaymentsPeriod],
      [loansSocial, loanPaymentsSocial, depositosCompartidos],
      allDebtPaymentsEver, interesPorDeuda, primerosPagos,
      incomeRecordsPeriod, allImpulseEver, allFixedPaymentsEver, incomeRecordsPeriodList,
    ] = await Promise.all([
      prisma.fixedExpensePayment.findMany({
        where: { fixedExpense: { userId }, createdAt: { gte: from, lte: to } },
        include: {
          fixedExpense: { select: { nombre: true } },
          tarjeta: { select: { nombre: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      Promise.all([
        prisma.externalLoan.findMany({ where: { userId, createdAt: { gte: from, lte: to } } }),
        prisma.externalLoanPayment.findMany({ where: { loan: { userId }, createdAt: { gte: from, lte: to } }, include: { loan: { select: { persona: true } } } }),
      ]),
      // ── Social: préstamos entre usuarios, sus abonos y ahorros compartidos ──
      // Antes nada de Social quedaba en Balance aunque moviera la billetera.
      Promise.all([
        prisma.loan.findMany({
          where: {
            OR: [{ lenderId: userId }, { borrowerId: userId }],
            status: { in: ['ACTIVE', 'PAID'] },
            activadoEn: { gte: from, lte: to },
          },
          include: { lender: { select: { nombre: true } }, borrower: { select: { nombre: true } } },
        }),
        prisma.loanPayment.findMany({
          where: {
            status: 'CONFIRMED',
            updatedAt: { gte: from, lte: to },
            // (ojo: NOT {nota: x} en SQL también descarta las notas vacías)
            OR: [{ nota: null }, { nota: { not: '__REMINDER__' } }],
            loan: { OR: [{ lenderId: userId }, { borrowerId: userId }] },
          },
          include: { loan: { select: { lenderId: true, lender: { select: { nombre: true } }, borrower: { select: { nombre: true } } } } },
        }),
        prisma.sharedDeposit.findMany({
          where: { userId, createdAt: { gte: from, lte: to } },
          include: { sharedPocket: { select: { nombre: true } } },
        }),
      ]),
      // Totales históricos de deudas (excluye pagos a tarjetas propias y marcadores)
      prisma.debtPayment.aggregate({
        where: { debt: { userId, tipoDeuda: { not: 'TARJETA_CREDITO' } }, esMarcador: false },
        _sum: { pagoInteres: true, abonoCapital: true, montoPagado: true },
      }),
      prisma.debtPayment.groupBy({
        by: ['debtId'],
        where: { debt: { userId } },
        _sum: { pagoInteres: true },
      }),
      // Saldo con el que cada deuda empezó a pagarse EN Kiri (ver interés evitado)
      prisma.debtPayment.findMany({
        where: { debt: { userId }, esMarcador: false },
        orderBy: { createdAt: 'asc' },
        distinct: ['debtId'],
        select: { debtId: true, saldoAnterior: true },
      }),
      prisma.incomeRecord.aggregate({
        where: { userId, createdAt: { gte: from, lte: to } },
        _sum: { monto: true },
      }),
      prisma.impulseExpense.aggregate({ where: { userId }, _sum: { monto: true } }),
      prisma.fixedExpensePayment.aggregate({
        where: { fixedExpense: { userId }, esMarcador: false },
        _sum: { montoPagado: true },
      }),
      prisma.incomeRecord.findMany({
        where: { userId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // Pagar el SALDO PROPIO de una tarjeta de crédito no es un gasto nuevo — el
    // gasto ya se contó una vez, al momento de cargarlo a la tarjeta (como pago
    // de la deuda original, o como gasto fijo pagado con esa tarjeta). Sumarlo
    // de nuevo aquí duplicaba el mismo dinero en "Total gastado": pagar un
    // gasto fijo de $100.000 con TC y luego abonar esos $100.000 a la tarjeta
    // sumaba $200.000 gastados por una sola compra real.
    //
    // Los pagos "marcador" (el usuario declaró que esa cuota ya la había pagado
    // por fuera de Kiri) solo existen para que la obligación no salga vencida:
    // ese dinero nunca salió de la billetera en Kiri, así que no es un egreso.
    const debtPaymentsForSpending = debtPayments.filter(p => p.debt.tipoDeuda !== 'TARJETA_CREDITO' && !p.esMarcador)
    const fixedPaymentsForSpending = fixedExpensePayments.filter(p => !p.esMarcador)

    // Tipo de cada movimiento de un ahorro compartido según su marca en la nota
    const tipoDeposito = (nota: string | null, monto: number): 'aporte' | 'previo' | 'retiro' | null => {
      const n = nota ?? ''
      if (n.includes('DELETE_REQUEST') || n.includes('RETIRO_PENDIENTE') || n.includes('RECHAZ')) return null
      if (n.includes('PREVIO')) return 'previo'
      if (n.includes('RETIRO')) return 'retiro'
      return monto > 0 ? 'aporte' : null
    }
    const ahorrosCompartidos = depositosCompartidos
      .map(d => ({ d, tipo: tipoDeposito(d.nota, Number(d.monto)) }))
      .filter((x): x is { d: typeof depositosCompartidos[number]; tipo: 'aporte' | 'previo' | 'retiro' } => x.tipo !== null)
    // Aportes a ahorros compartidos desde la billetera también son ahorro del periodo
    const ahorroCompartidoNeto = ahorrosCompartidos.reduce((s, x) =>
      x.tipo === 'aporte' ? s + Number(x.d.monto) : x.tipo === 'retiro' ? s - Math.abs(Number(x.d.monto)) : s, 0)

    // ── Totales para el balance ─────────────────────────────────────────────────

    const totalImpulse = impulseExpenses.reduce((s, e) => s + Number(e.monto), 0)
    // Neto del periodo: lo depositado menos lo retirado — antes un retiro de
    // bolsillo no restaba nada porque ni siquiera se registraba (ver BAL-05).
    const totalSaved   = savingsHistory.filter(e => e.tipo === 'ahorro').reduce((s, e) => s + Number(e.monto), 0)
      - savingsHistory.filter(e => e.tipo === 'retiro').reduce((s, e) => s + Number(e.monto), 0)
      + ahorroCompartidoNeto
    const totalExtra   = extraIncomes.reduce((s, e) => s + Number(e.monto), 0)
    // Deudas y fijos EFECTIVAMENTE PAGADOS dentro del rango — se toma del ledger
    // de pagos (montoPagado real), no de una columna "pagado" que ya no existe.
    const totalDebts   = debtPaymentsForSpending.reduce((s, p) => s + Number(p.montoPagado), 0)
    const totalFixed   = fixedPaymentsForSpending.reduce((s, p) => s + Number(p.montoPagado), 0)

    // ── Amortización: intereses pagados vs capital abonado ────────────────────
    const totalInteresPagado = debtPaymentsForSpending.reduce((s, p) => s + Number(p.pagoInteres), 0)
    const totalCapitalAbonado = debtPaymentsForSpending.reduce((s, p) => s + Number(p.abonoCapital), 0)
    const totalPagosDeuda = debtPaymentsForSpending.reduce((s, p) => s + Number(p.montoPagado), 0)

    // Intereses ahorrados: si el usuario paga más de la cuota mínima, ahorra intereses futuros
    // Cálculo simplificado: por cada peso extra abonado al capital, se evita pagar interés sobre ese peso
    // (excluye pagos a tarjetas propias — mismo motivo que debtPaymentsForSpending)
    const totalInteresHistorico = Number(allDebtPaymentsEver._sum.pagoInteres ?? 0)
    const totalCapitalHistorico = Number(allDebtPaymentsEver._sum.abonoCapital ?? 0)

    // ── Interés evitado: cuánto interés te ahorraste pagando más que el mínimo ──
    // Por deuda: interés total SI solo se hubieran hecho pagos mínimos (tabla de
    // amortización completa desde el monto inicial) vs interés real proyectado
    // (lo ya pagado + lo que falta proyectado desde el saldo ACTUAL, que es menor
    // porque hubo abonos extra). La diferencia es interés que ya no se pagará.
    const interesPagadoPorDeuda = new Map(interesPorDeuda.map(r => [r.debtId, Number(r._sum.pagoInteres ?? 0)]))
    // Saldo con el que cada deuda empezó a pagarse EN Kiri (el saldo antes de su
    // primer pago real). Antes la base era el monto original: una deuda de
    // $6,5M registrada con saldo $2,3M (lo demás pagado por fuera, en cuotas
    // normales) salía con millones de "interés evitado por tus abonos extra"
    // sin que el usuario hubiera abonado nada extra.
    const saldoAlEntrar = new Map(primerosPagos.map(p => [p.debtId, Number(p.saldoAnterior)]))

    let interesEvitado = 0
    for (const d of debts) {
      // Tasa por PERIODO de la deuda (mitad de la mensual si es quincenal) —
      // la tabla avanza de a una cuota, así que debe usar la tasa de cada cuota.
      const tasa = tasaDelPeriodo(d.tasaInteresAplicada ? Number(d.tasaInteresAplicada) : (d.tasaInteres ? Number(d.tasaInteres) : null), d.frecuenciaPago)
      if (!tasa || tasa <= 0) continue
      const cuota = Number(d.cuotaPeriodo)
      if (!cuota || cuota <= 0) continue

      // Sin pagos en Kiri todavía no hay abonos que comparar
      const base = saldoAlEntrar.get(d.id)
      if (base === undefined || base <= 0) continue
      const interesOriginalTotal = generarTablaAmortizacion(base, tasa, cuota)
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

    // Ingresos reales registrados DENTRO del periodo (consultados arriba)
    const ingresosRealPeriodo = Number(incomeRecordsPeriod._sum.monto ?? 0)

    // totalIngreso: si hay registros reales en el periodo, usar esos. Si no, usar base + extra.
    const totalIngreso = ingresosRealPeriodo > 0 ? ingresosRealPeriodo + totalExtra : ingresoBase + totalExtra
    // totalEgreso: lo que realmente se ha pagado/gastado en el periodo
    const totalFixedPaid = totalFixed
    const totalEgreso  = totalPagosDeuda + totalFixedPaid + totalImpulse

    // Totales históricos (toda la vida)
    const totalIngresosHistorico = Number(incomeRecordsAll._sum.monto ?? 0)
    // Egresos históricos: suma de todos los pagos de deuda + impulse + gastos fijos
    // pagados — los tres SIN acotar por from/to. totalFixedPaid sí está acotado
    // por el rango pedido (es correcto para el resumen del periodo), así que
    // usarlo aquí hacía que "histórico" variara según qué rango se pidiera —
    // p. ej. daba $50.000 al pedir un mes sin gastos fijos pagados y $95.000
    // al pedir el mes actual, para la MISMA cuenta.
    const allDebtPaymentsTotal = Number(allDebtPaymentsEver._sum.montoPagado ?? 0)
    const totalEgresosHistorico = allDebtPaymentsTotal + Number(allFixedPaymentsEver._sum.montoPagado ?? 0) + Number(allImpulseEver._sum.monto ?? 0)

    // ── Distribución por categoría (para pie chart) ───────────────────────────
    const categoryDistribution = [
      { name: 'Deudas',          value: totalDebts,   color: '#8096E6' },
      { name: 'Gastos Fijos',    value: totalFixed,   color: '#A2D2FF' },
      // impulse_expenses guarda TODOS los gastos variables — solo los marcados
      // esHormiga son hormiga; el resto (ej. un vuelo) va aparte.
      { name: 'Gastos Hormiga',  value: impulseExpenses.filter(e => e.esHormiga).reduce((s, e) => s + Number(e.monto), 0), color: '#FFB3C6' },
      { name: 'Gastos Variables', value: impulseExpenses.filter(e => !e.esHormiga).reduce((s, e) => s + Number(e.monto), 0), color: '#FFD6A5' },
      { name: 'Ahorro',          value: totalSaved,   color: '#B9FBC0' },
    ].filter(c => c.value > 0)

    // ── Serie temporal de ingresos vs egresos (para chart) ─────────────────
    // Granularidad dinámica según timeframe. Para "custom" (rango elegido a
    // mano, ej. un mes específico del PDF) se decide por la duración real del
    // rango: por día si cabe en ~un mes, por mes si es más largo.
    const spanDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
    const getKey = (date: Date): string => {
      switch (timeframe) {
        case 'week':
          // Por día: "lun 14", "mar 15"...
          return date.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' })
        case 'month':
          // Por día: "1 jul", "2 jul"...
          return date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
        case 'custom':
          return spanDays <= 31
            ? date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
            : date.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })
        case 'year':
        case 'all':
        default:
          // Por mes: "ene 2026", "feb 2026"...
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
    debtPaymentsForSpending.forEach(p => addToMonth(new Date(p.createdAt), 'egresos', Number(p.montoPagado)))
    // Gastos fijos pagados — fecha real de cada pago del ledger, no `updatedAt`
    // de la fila (que se mueve con cualquier PATCH, no solo con un pago)
    fixedPaymentsForSpending.forEach(p => addToMonth(new Date(p.createdAt), 'egresos', Number(p.montoPagado)))

    // Ingresos reales registrados
    incomeRecordsPeriodList.forEach(r => addToMonth(new Date(r.createdAt), 'ingresos', Number(r.monto)))
    extraIncomes.forEach(e => addToMonth(new Date(e.createdAt), 'ingresos', Number(e.monto)))

    const monthlySeries = Object.entries(timeMap)
      .map(([month, vals]) => ({ month, ingresos: vals.ingresos, egresos: vals.egresos, ts: vals.ts }))
      .sort((a, b) => a.ts - b.ts)
      .map(({ month, ingresos, egresos }) => ({ month, ingresos, egresos }))

    res.json({
      timeframe,
      historialLimitado,
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
      impulseExpenses:  impulseExpenses.map(e => ({ ...e, monto: Number(e.monto), tarjetaNombre: e.tarjeta?.nombre ?? null, tarjeta: undefined })),
      savingsHistory:   savingsHistory.map(e => ({ ...e, monto: Number(e.monto) })),
      extraIncomes:     extraIncomes.map(e => ({ ...e, monto: Number(e.monto) })),
      debts: debts.map(d => {
        const periodo = itemPeriodo(d.frecuenciaPago === 'quincenal' ? 'quincenal' : 'mensual', d.diasPago)
        const paid = debtPayments.filter(p => p.debtId === d.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
        return {
          ...d,
          // Prisma serializa Decimal como STRING en JSON (Decimal.toJSON()).
          // Antes solo se convertían montoTotal/cuotaPeriodo acá — el resto
          // (saldoRestante en particular) llegaba al frontend como texto, y
          // sumarlo con `+` hacía concatenación de strings en vez de suma
          // numérica: "11300000" + "4520000" → "114520000"... un número
          // gigante sin sentido en vez de un total real (visible en el PDF
          // exportado como "Saldo restante $1.130.000.045.200.002.130.000").
          montoTotal: Number(d.montoTotal),
          montoInicial: d.montoInicial != null ? Number(d.montoInicial) : null,
          saldoRestante: Number(d.saldoRestante),
          saldoPrincipal: d.saldoPrincipal != null ? Number(d.saldoPrincipal) : null,
          cuotaPeriodo: Number(d.cuotaPeriodo),
          tasaInteres: d.tasaInteres != null ? Number(d.tasaInteres) : null,
          tasaInteresAplicada: d.tasaInteresAplicada != null ? Number(d.tasaInteresAplicada) : null,
          tasaInteresMensual: d.tasaInteresMensual != null ? Number(d.tasaInteresMensual) : null,
          pagadoEstePeriodo: paid >= cuotaBaseDelPeriodo(d, periodo),
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

      // Historial de amortización — excluye pagos al saldo propio de una
      // tarjeta (ver debtPaymentsForSpending) para que la suma de estas filas
      // coincida con summary.totalDebts/totalEgreso, no las duplique.
      debtPayments: debtPaymentsForSpending.map(p => ({
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
        tarjetaNombre: p.tarjeta?.nombre ?? null,
      })),

      // Ledger real de pagos de gastos fijos dentro del rango pedido — a
      // diferencia de fixedExpenses[].pagadoEstePeriodo (que SIEMPRE refleja
      // el periodo actual sin importar from/to), esta lista sí respeta el
      // rango solicitado. Es lo que debe usar la UI para construir la tabla
      // de "Detalle de transacciones", no el flag de arriba.
      fixedExpensePayments: fixedPaymentsForSpending.map(p => ({
        id: p.id,
        nombre: p.fixedExpense.nombre,
        montoPagado: Number(p.montoPagado),
        periodo: p.periodo,
        createdAt: p.createdAt,
        tarjetaNombre: p.tarjeta?.nombre ?? null,
      })),

      // Ingresos registrados (sueldo + extras)
      incomeRecords: incomeRecordsPeriodList.map(r => ({ ...r, monto: Number(r.monto) })),

      // "Me deben": préstamos a personas sin Kiri y sus abonos dentro del
      // rango. Solo para el historial — NO suman a ingresos ni egresos (prestar
      // no es gastar, y que te devuelvan no es ganar), pero sí explican por qué
      // bajó o subió el disponible.
      // Social: igual que "Me deben", los préstamos y sus abonos NO suman a
      // ingresos ni egresos (prestar no es gastar), pero explican por qué
      // subió o bajó el disponible. Los aportes a ahorros compartidos sí
      // cuentan como ahorro del periodo (ya van en summary.totalSaved).
      social: {
        prestamos: loansSocial.map(l => {
          const yoPreste = l.lenderId === userId
          return {
            id: l.id, conQuien: (yoPreste ? l.borrower.nombre : l.lender.nombre),
            rol: yoPreste ? 'preste' : 'me_prestaron', monto: Number(l.montoOriginal ?? l.amount),
            previo: l.sinDesembolso, descripcion: l.descripcion, fecha: l.activadoEn ?? l.createdAt,
          }
        }),
        abonos: loanPaymentsSocial.map(p => {
          const recibi = p.loan.lenderId === userId
          return {
            id: p.id, conQuien: recibi ? p.loan.borrower.nombre : p.loan.lender.nombre,
            rol: recibi ? 'recibi' : 'pague', monto: Number(p.monto), fecha: p.updatedAt,
          }
        }),
        ahorros: ahorrosCompartidos.map(({ d, tipo }) => ({
          id: d.id, bolsillo: d.sharedPocket.nombre, tipo, monto: Math.abs(Number(d.monto)), fecha: d.createdAt,
        })),
      },

      prestamosExternos: {
        prestamos: externalLoansPeriod.map(l => ({
          id: l.id, persona: l.persona, monto: Number(l.montoPrestado),
          desdeBilletera: Number(l.montoDesdeBilletera) > 0, fecha: l.createdAt,
        })),
        abonos: externalPaymentsPeriod.map(p => ({
          id: p.id, persona: p.loan.persona, monto: Number(p.monto),
          entraABilletera: p.entraABilletera, fecha: p.createdAt,
        })),
      },
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
