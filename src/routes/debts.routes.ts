import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { sendPushToUser } from '../lib/push.js'
import { checkLimit, attachUsageWarning } from '../middleware/limit-enforcement.js'
import { recordMissionAction, recordOnboardingAction } from '../lib/missions.js'
import { getPeriodo, getMontoPorPeriodo, parseDiasPago } from '../lib/period.js'
import { planPocketDeduction } from '../lib/wallet.js'
import { randomUUID } from 'crypto'
import type { DebtPayment, DebtCardInstallment, Prisma } from '@prisma/client'

// ─── Estado derivado por periodo ────────────────────────────────────────────────
// pagadoEstePeriodo/montoPagadoEstePeriodo ya no son columnas: se calculan sumando
// los DebtPayment cuyo `periodo` coincide con el periodo actual de la deuda. Así,
// al cruzar a un periodo nuevo (quincena/mes siguiente) el monto vuelve a $0 solo,
// sin necesitar un cron que resetee nada.
//
// La frontera Q1/Q2 de una deuda QUINCENAL usa sus PROPIOS `diasPago` (ej. "5,28"
// — las dos fechas reales en que se cobra ESA deuda), no los días de pago del
// sueldo del usuario: son dos ciclos distintos (cuándo te pagan a ti vs. cuándo
// te cobran a ti esta deuda en particular) que pueden no coincidir en absoluto.
function debtPeriodo(debt: { frecuenciaPago: string; diasPago: string }, now: Date = new Date()): string {
  if (debt.frecuenciaPago !== 'quincenal') return getPeriodo('mensual', [], now)
  return getPeriodo('quincenal', parseDiasPago(debt.diasPago), now)
}

interface DebtPeriodStatus {
  periodo: string
  montoPagadoEstePeriodo: number
  interesPagadoEstePeriodo: number
  /** Saldo justo antes del primer pago del periodo actual — base para calcular el interés del periodo completo */
  saldoAlIniciarPeriodo: number
}

function computePeriodStatus(payments: DebtPayment[], periodo: string, saldoActualFallback: number): DebtPeriodStatus {
  const own = payments.filter(p => p.periodo === periodo).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const montoPagadoEstePeriodo = own.reduce((s, p) => s + Number(p.montoPagado), 0)
  const interesPagadoEstePeriodo = own.reduce((s, p) => s + Number(p.pagoInteres), 0)
  const saldoAlIniciarPeriodo = own.length > 0 ? Number(own[0].saldoAnterior) : saldoActualFallback
  return { periodo, montoPagadoEstePeriodo, interesPagadoEstePeriodo, saldoAlIniciarPeriodo }
}

interface PagoDeudaResult {
  pagoInteres: number
  abonoCapital: number
  nuevoSaldo: number
  nuevoEstado: 'activa' | 'saldada'
}

/**
 * Calcula cómo se divide un pago de deuda entre interés y abono a capital —
 * usada tanto por /pay como por /pay-with-card, para que pagar con tarjeta NO
 * se salte el interés real de la deuda que se está pagando (el costo financiero
 * de esa deuda no depende de cómo se pagó, solo de su saldo y tasa).
 */
function calcularPagoDeuda(currentSaldo: number, tasaMensual: number | null, status: DebtPeriodStatus, montoPago: number): PagoDeudaResult {
  const interesTotalPeriodo = tasaMensual && tasaMensual > 0
    ? Math.round(status.saldoAlIniciarPeriodo * (tasaMensual / 100) * 100) / 100
    : 0
  const interesRestante = Math.max(0, Math.round((interesTotalPeriodo - status.interesPagadoEstePeriodo) * 100) / 100)
  // El interés de este pago nunca puede superar ni el efectivo pagado ni lo que falta del periodo.
  const pagoInteres = Math.min(montoPago, interesRestante)
  const abonoCapital = Math.round((montoPago - pagoInteres) * 100) / 100
  const nuevoSaldo = Math.max(0, Math.round((currentSaldo - abonoCapital) * 100) / 100)
  const nuevoEstado: 'activa' | 'saldada' = nuevoSaldo <= 0 ? 'saldada' : 'activa'
  return { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado }
}

/** Meses de calendario completos entre dos fechas (ignora el día del mes). */
function mesesTranscurridos(desde: Date, hasta: Date): number {
  return (hasta.getFullYear() - desde.getFullYear()) * 12 + (hasta.getMonth() - desde.getMonth())
}

/**
 * Cuota efectiva de una tarjeta: la cuota base (la que el usuario definió al
 * crear/editar la tarjeta) más los planes de cuotas de pay-with-card que siguen
 * vigentes. Un plan deja de sumar solo, sin cron ni que nadie lo borre, cuando
 * ya pasaron sus `cuotasTotal` meses — mismo patrón "periodo" del resto de la app.
 */
function cuotaEfectivaTarjeta(cuotaBase: number, installments: DebtCardInstallment[], now: Date = new Date()): number {
  const activos = installments.filter(p => mesesTranscurridos(p.createdAt, now) < p.cuotasTotal)
  const sumaActivos = activos.reduce((s, p) => s + Number(p.cuotaMensual), 0)
  return Math.round((cuotaBase + sumaActivos) * 100) / 100
}

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createDebtSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  montoTotal: z.number().min(0.01),
  saldoRestante: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0.01),
  acreedor: z.string().default(''),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).default('mensual'),
  diasPago: z.string().default('1'), // "15" o "15,30"
  tasaInteres: z.number().min(0).optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).default('media'),
  bankEntityId: z.string().uuid().nullable().optional(),
  tipoDeuda: z.enum(['PRESTAMO', 'TARJETA_CREDITO']).default('PRESTAMO'),
})

const updateDebtSchema = z.object({
  nombre: z.string().min(1).optional(),
  montoTotal: z.number().min(0).optional(),
  saldoRestante: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0).optional(),
  acreedor: z.string().optional(),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).optional(),
  diasPago: z.string().optional(),
  tasaInteres: z.number().min(0).nullable().optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).optional(),
  estado: z.enum(['activa', 'saldada', 'vencida']).optional(),
  pagoAutomatico: z.boolean().optional(),
}).strict()

const payDebtSchema = z.object({
  monto: z.number().min(0.01).optional(), // Si no se envía, usa cuotaPeriodo
})

// ─── GET /debts ───────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const estado = (req.query.estado as string) || 'activa'

    const debts = await prisma.debt.findMany({ where: { userId, estado }, orderBy: { createdAt: 'desc' } })

    // Traer los pagos recientes de todas las deudas en una sola query (evita N+1).
    // 40 días cubre de sobra un mes calendario o una quincena en curso.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const recentPayments = debts.length > 0
      ? await prisma.debtPayment.findMany({
          where: { debtId: { in: debts.map(d => d.id) }, createdAt: { gte: fortyDaysAgo } },
        })
      : []
    const paymentsByDebt = new Map<string, DebtPayment[]>()
    for (const p of recentPayments) {
      const arr = paymentsByDebt.get(p.debtId) ?? []
      arr.push(p)
      paymentsByDebt.set(p.debtId, arr)
    }

    // Planes de cuotas de tarjeta (pay-with-card) — solo aplica a tarjetas de
    // crédito, pero se trae para todas en una sola query igual de simple.
    const tarjetaIds = debts.filter(d => d.tipoDeuda === 'TARJETA_CREDITO').map(d => d.id)
    const installments = tarjetaIds.length > 0
      ? await prisma.debtCardInstallment.findMany({ where: { tarjetaId: { in: tarjetaIds } } })
      : []
    const installmentsByTarjeta = new Map<string, DebtCardInstallment[]>()
    for (const p of installments) {
      const arr = installmentsByTarjeta.get(p.tarjetaId) ?? []
      arr.push(p)
      installmentsByTarjeta.set(p.tarjetaId, arr)
    }

    res.json({
      debts: debts.map(d => {
        const periodo = debtPeriodo(d)
        const status = computePeriodStatus(paymentsByDebt.get(d.id) ?? [], periodo, Number(d.saldoRestante))
        const cuotaPeriodo = d.tipoDeuda === 'TARJETA_CREDITO'
          ? cuotaEfectivaTarjeta(Number(d.cuotaPeriodo), installmentsByTarjeta.get(d.id) ?? [])
          : Number(d.cuotaPeriodo)
        return {
          ...d,
          montoTotal: Number(d.montoTotal),
          saldoRestante: Number(d.saldoRestante),
          cuotaPeriodo,
          tasaInteres: d.tasaInteres ? Number(d.tasaInteres) : null,
          pagadoEstePeriodo: status.montoPagadoEstePeriodo >= cuotaPeriodo,
          montoPagadoEstePeriodo: status.montoPagadoEstePeriodo > 0 ? status.montoPagadoEstePeriodo : null,
        }
      }),
    })
  } catch (error) {
    console.error('[GetDebts]', error)
    res.status(500).json({ error: 'Error al obtener deudas' })
  }
})

// ─── POST /debts ──────────────────────────────────────────────────────────────

router.post('/', validate(createDebtSchema), checkLimit('nDeudas'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, montoTotal, saldoRestante, cuotaPeriodo, acreedor, frecuenciaPago, diasPago, tasaInteres, prioridad, bankEntityId, tipoDeuda } = req.body

    const debt = await prisma.debt.create({
      data: {
        userId,
        nombre,
        tipoDeuda: tipoDeuda || 'PRESTAMO',
        montoTotal,
        // Si el usuario ingresó un saldo actual diferente (ya venía pagando), usarlo
        saldoRestante: saldoRestante ?? montoTotal,
        montoInicial: montoTotal,
        cuotaPeriodo,
        acreedor: acreedor || '',
        frecuenciaPago: frecuenciaPago || 'mensual',
        diasPago: diasPago || '1',
        tasaInteres: tasaInteres ?? null,
        tasaInteresAplicada: tasaInteres ?? null,
        prioridad: prioridad || 'media',
        estado: 'activa',
        fechaInicio: new Date(),
        bankEntityId: bankEntityId || null,
      },
    })

    await recordOnboardingAction(userId, 'registrar_obligacion')

    res.status(201).json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
        pagadoEstePeriodo: false,
        montoPagadoEstePeriodo: null,
      },
    })
  } catch (error) {
    console.error('[CreateDebt]', error)
    res.status(500).json({ error: 'Error al crear deuda' })
  }
})

// ─── POST /debts/:id/pay ──────────────────────────────────────────────────────
// Registra un pago de cuota con cálculo de amortización.
// Si la deuda tiene tasa de interés, divide el pago en interés + abono a capital.
// Solo el abono a capital reduce el saldoRestante.
// Registra el historial en debt_payments.

router.post('/:id/pay', validate(payDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId, estado: 'activa' } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda activa no encontrada' })
      return
    }

    const montoPago = req.body.monto ?? Number(existing.cuotaPeriodo)
    const currentSaldo = Number(existing.saldoRestante)

    // Obtener la tasa de interés aplicada (prioridad: tasaInteresAplicada > tasaInteres)
    const tasaMensual = existing.tasaInteresAplicada
      ? Number(existing.tasaInteresAplicada)
      : existing.tasaInteres
        ? Number(existing.tasaInteres)
        : null

    // Periodo actual de esta deuda + pagos ya registrados en ese periodo.
    const periodo = debtPeriodo(existing)
    const paymentsThisPeriod = await prisma.debtPayment.findMany({ where: { debtId: id, periodo } })
    const status = computePeriodStatus(paymentsThisPeriod, periodo, currentSaldo)

    // Interés calculado UNA SOLA VEZ por periodo, sobre el saldo con que arrancó
    // el periodo — así, partir un pago en abonos parciales no cuesta más interés
    // total que pagarlo de una sola vez.
    const { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado } = calcularPagoDeuda(currentSaldo, tasaMensual, status, montoPago)

    const totalPaidThisPeriod = status.montoPagadoEstePeriodo + montoPago
    const cuotaCubierta = totalPaidThisPeriod >= Number(existing.cuotaPeriodo)

    // El descuento de billetera va en la MISMA transacción que el pago — antes
    // era una segunda llamada HTTP aparte (userApi.walletDeduct) que si fallaba
    // dejaba la deuda "pagada" sin que el saldo disponible bajara.
    const walletDeductionData = planPocketDeduction('obligaciones', montoPago)

    const [debt, payment] = await prisma.$transaction([
      prisma.debt.update({
        where: { id },
        data: { saldoRestante: nuevoSaldo, estado: nuevoEstado },
      }),
      prisma.debtPayment.create({
        data: {
          debtId: id,
          montoPagado: montoPago,
          abonoCapital,
          pagoInteres,
          saldoAnterior: currentSaldo,
          saldoPosterior: nuevoSaldo,
          periodo,
        },
      }),
      prisma.user.update({ where: { id: userId }, data: walletDeductionData }),
    ])

    await recordMissionAction(userId, 'pagar_obligacion')

    res.json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        pagadoEstePeriodo: cuotaCubierta,
        montoPagadoEstePeriodo: totalPaidThisPeriod > 0 ? totalPaidThisPeriod : null,
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
      },
      amortizacion: {
        montoPagado: montoPago,
        pagoInteres,
        abonoCapital,
      },
      pagado: montoPago,
      saldoAnterior: currentSaldo,
      saldoNuevo: nuevoSaldo,
      liquidada: nuevoEstado === 'saldada',
    })

    // Push notification de pago realizado
    const debtName = existing.nombre
    sendPushToUser(userId, {
      title: nuevoEstado === 'saldada' ? '🎉 ¡Deuda liquidada!' : '✅ Pago registrado',
      body: nuevoEstado === 'saldada'
        ? `¡Felicidades! Terminaste de pagar "${debtName}".`
        : `Pagaste $${montoPago.toLocaleString('es-CO')} de "${debtName}". Saldo restante: $${nuevoSaldo.toLocaleString('es-CO')}`,
      tag: 'debt-payment',
      url: '/obligaciones',
    }).catch(() => {})
  } catch (error) {
    console.error('[PayDebt]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── POST /debts/:id/undo-pay ─────────────────────────────────────────────────
// Revierte un pago de cuota. Devuelve el monto al saldoRestante y al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    // Buscar deuda del usuario
    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    // Solo se puede deshacer un pago que quede DENTRO del periodo actual de la
    // deuda — al no haber columnas mutables, el periodo es lo único que define
    // "el pago más reciente"; un pago de un periodo ya cerrado no se puede tocar.
    const periodo = debtPeriodo(existing)
    const payments = await prisma.debtPayment.findMany({
      where: { debtId: id, periodo },
      orderBy: { createdAt: 'desc' },
    })
    if (payments.length === 0) {
      res.status(404).json({ error: 'No hay pagos registrados para deshacer' })
      return
    }

    // El saldoRestante solo se redujo por el capital (no por intereses), así que
    // debemos devolver solo el CAPITAL al saldo, no el monto total pagado —
    // esto aplica sin importar cómo se pagó (efectivo o tarjeta).
    const totalCapitalAbonado = payments.reduce((sum, p) => sum + Number(p.abonoCapital), 0)

    // Separar los pagos del periodo entre efectivo y tarjeta: solo los de
    // efectivo devuelven dinero a cashBalance — los de tarjeta nunca lo
    // tocaron, así que revertirlos significa restarle a LA TARJETA (no
    // sumarle a la billetera) y borrar el plan de cuotas que generaron.
    const cashPayments = payments.filter(p => !p.tarjetaId)
    const cardPayments = payments.filter(p => p.tarjetaId)
    const montoDevolver = cashPayments.reduce((sum, p) => sum + Number(p.montoPagado), 0)

    const montoPorTarjeta = new Map<string, number>()
    const installmentIds = new Set<string>()
    for (const p of cardPayments) {
      montoPorTarjeta.set(p.tarjetaId!, (montoPorTarjeta.get(p.tarjetaId!) ?? 0) + Number(p.montoPagado))
      if (p.installmentId) installmentIds.add(p.installmentId)
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.debt.update({
        where: { id },
        data: {
          saldoRestante: { increment: totalCapitalAbonado },
          estado: 'activa',
        },
      }),
    ]
    if (montoDevolver > 0) {
      ops.push(prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: montoDevolver },
          walletObligaciones: { increment: montoDevolver },
        },
      }))
    }
    for (const [tarjetaId, monto] of montoPorTarjeta) {
      ops.push(prisma.debt.update({
        where: { id: tarjetaId },
        data: {
          saldoRestante: { decrement: monto },
          saldoPrincipal: { decrement: monto },
        },
      }))
    }
    if (installmentIds.size > 0) {
      ops.push(prisma.debtCardInstallment.deleteMany({ where: { id: { in: [...installmentIds] } } }))
    }
    // Eliminar registros de pago del periodo (historial de amortización)
    ops.push(prisma.debtPayment.deleteMany({ where: { debtId: id, periodo } }))

    const results = await prisma.$transaction(ops)
    const debt = results[0] as typeof existing

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

    res.json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        pagadoEstePeriodo: false,
        montoPagadoEstePeriodo: null,
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
      },
      montoDevuelto: montoDevolver,
      revertidoDeTarjeta: montoPorTarjeta.size > 0
        ? [...montoPorTarjeta.entries()].map(([tarjetaId, monto]) => ({ tarjetaId, monto }))
        : null,
      wallet: {
        cashBalance: Number(user?.cashBalance ?? 0),
        ahorro: Number(user?.walletAhorro ?? 0),
        obligaciones: Number(user?.walletObligaciones ?? 0),
        libre: Number(user?.walletLibre ?? 0),
        endeudamiento: Number(user?.walletEndeudamiento ?? 0),
      },
    })
  } catch (error) {
    console.error('[UndoPayDebt]', error)
    res.status(500).json({ error: 'Error al deshacer pago de deuda' })
  }
})

// ─── PATCH /debts/:id ─────────────────────────────────────────────────────────

router.patch('/:id', validate(updateDebtSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    // Al editar la tasa declarada, sincronizar también la tasa APLICADA — antes
    // quedaban desincronizadas (el pago siempre usa tasaInteresAplicada, que se
    // congelaba en el valor de creación y nunca se actualizaba desde acá).
    const data: Record<string, unknown> = { ...req.body }
    if ('tasaInteres' in req.body) {
      data.tasaInteresAplicada = req.body.tasaInteres
    }

    const debt = await prisma.debt.update({ where: { id }, data })

    const periodo = debtPeriodo(debt)
    const paymentsThisPeriod = await prisma.debtPayment.findMany({ where: { debtId: id, periodo } })
    const status = computePeriodStatus(paymentsThisPeriod, periodo, Number(debt.saldoRestante))

    res.json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
        pagadoEstePeriodo: status.montoPagadoEstePeriodo >= Number(debt.cuotaPeriodo),
        montoPagadoEstePeriodo: status.montoPagadoEstePeriodo > 0 ? status.montoPagadoEstePeriodo : null,
      },
    })
  } catch (error) {
    console.error('[UpdateDebt]', error)
    res.status(500).json({ error: 'Error al actualizar deuda' })
  }
})

// ─── DELETE /debts/:id ────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    await prisma.debt.delete({ where: { id } })
    res.json({ message: 'Deuda eliminada' })
  } catch (error) {
    console.error('[DeleteDebt]', error)
    res.status(500).json({ error: 'Error al eliminar deuda' })
  }
})

// ─── POST /debts/pay-with-card — Pagar obligación con tarjeta de crédito en cuotas ─
// Recibe: tarjetaId, monto, cuotas, sourceType (debt|fixed), sourceId
// Lógica:
//   1. Marca la obligación original como pagada (si es una deuda, con su
//      interés real de por medio — ver calcularPagoDeuda)
//   2. Suma el monto total al saldoRestante de la tarjeta
//   3. Crea un DebtCardInstallment de (monto / cuotas) por mes — la cuota
//      EFECTIVA de la tarjeta (ver cuotaEfectivaTarjeta) sube mientras el plan
//      esté vigente y baja sola cuando termina, sin mutar cuotaPeriodo directo

const payWithCardSchema = z.object({
  tarjetaId: z.string().uuid(),
  monto: z.number().min(0.01),
  cuotas: z.number().int().min(1).max(48),
  sourceType: z.enum(['debt', 'fixed']),
  sourceId: z.string().uuid(),
})

router.post('/pay-with-card', validate(payWithCardSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { tarjetaId, monto, cuotas, sourceType, sourceId } = req.body

    // Verificar que la tarjeta existe y pertenece al usuario
    const tarjeta = await prisma.debt.findFirst({ where: { id: tarjetaId, userId, estado: 'activa' } })
    if (!tarjeta) {
      res.status(404).json({ error: 'Tarjeta de crédito no encontrada' })
      return
    }

    // Calcular incremento de cuota = monto / cuotas
    const incrementoCuota = Math.round((monto / cuotas) * 100) / 100

    if (sourceType === 'debt') {
      // Verificar que la deuda existe
      const deuda = await prisma.debt.findFirst({ where: { id: sourceId, userId, estado: 'activa' } })
      if (!deuda) {
        res.status(404).json({ error: 'Deuda no encontrada' })
        return
      }

      const montoPago = monto
      const currentSaldo = Number(deuda.saldoRestante)
      const tasaMensual = deuda.tasaInteresAplicada
        ? Number(deuda.tasaInteresAplicada)
        : deuda.tasaInteres
          ? Number(deuda.tasaInteres)
          : null
      const periodo = debtPeriodo(deuda)
      const paymentsThisPeriod = await prisma.debtPayment.findMany({ where: { debtId: sourceId, periodo } })
      const status = computePeriodStatus(paymentsThisPeriod, periodo, currentSaldo)

      // Pagar con tarjeta NO exime del interés de la deuda original — el costo
      // financiero de esa deuda depende de su saldo y tasa, no de cómo se pagó.
      // Misma función que usa /pay, para que partir/completar con tarjeta calce
      // exactamente igual que hacerlo en efectivo.
      const { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado } = calcularPagoDeuda(currentSaldo, tasaMensual, status, montoPago)

      // El id del plan de cuotas se genera ANTES de la transacción para poder
      // enlazarlo desde el mismo DebtPayment que lo originó — así undo-pay
      // sabe exactamente qué plan borrar y qué tarjeta revertir, en vez de
      // adivinar (antes no había ningún enlace: undo-pay trataba TODO pago
      // como si hubiera salido en efectivo, sin importar cómo se pagó).
      const installmentId = randomUUID()

      await prisma.$transaction([
        // El plan de cuotas va PRIMERO: el pago lo referencia por FK
        // (installmentId), así que debe existir antes de que se cree el pago
        // que apunta a él — Postgres valida la llave foránea al momento de
        // cada statement dentro de la transacción, no al final.
        prisma.debtCardInstallment.create({
          data: { id: installmentId, tarjetaId, cuotaMensual: incrementoCuota, cuotasTotal: cuotas, descripcion: deuda.nombre },
        }),
        prisma.debt.update({
          where: { id: sourceId },
          data: { saldoRestante: nuevoSaldo, estado: nuevoEstado },
        }),
        prisma.debtPayment.create({
          data: {
            debtId: sourceId,
            montoPagado: montoPago,
            abonoCapital,
            pagoInteres,
            saldoAnterior: currentSaldo,
            saldoPosterior: nuevoSaldo,
            periodo,
            tarjetaId,
            installmentId,
          },
        }),
        // La tarjeta sí recibe el monto completo (ella le presta el 100% al
        // usuario, sin importar cuánto de eso era interés de la deuda original)
        prisma.debt.update({
          where: { id: tarjetaId },
          data: {
            saldoRestante: { increment: monto },
            saldoPrincipal: { increment: monto },
          },
        }),
      ])
    } else {
      // sourceType === 'fixed'
      const gasto = await prisma.fixedExpense.findFirst({ where: { id: sourceId, userId } })
      if (!gasto) {
        res.status(404).json({ error: 'Gasto fijo no encontrado' })
        return
      }

      const montoPorPeriodo = getMontoPorPeriodo(Number(gasto.monto), gasto.frecuencia)
      const montoPago = monto || montoPorPeriodo
      const periodoGasto = gasto.frecuencia === 'quincenal'
        ? getPeriodo('quincenal', parseDiasPago(gasto.fechaCorte))
        : getPeriodo(gasto.frecuencia)

      const installmentId = randomUUID()

      await prisma.$transaction([
        prisma.debtCardInstallment.create({
          data: { id: installmentId, tarjetaId, cuotaMensual: incrementoCuota, cuotasTotal: cuotas, descripcion: gasto.nombre },
        }),
        prisma.fixedExpensePayment.create({
          data: { fixedExpenseId: sourceId, montoPagado: montoPago, periodo: periodoGasto, tarjetaId, installmentId },
        }),
        prisma.debt.update({
          where: { id: tarjetaId },
          data: {
            saldoRestante: { increment: monto },
            saldoPrincipal: { increment: monto },
          },
        }),
      ])
    }

    // Obtener estado actualizado de la tarjeta + su cuota efectiva (base + planes vigentes)
    const [tarjetaActualizada, installments] = await Promise.all([
      prisma.debt.findUnique({ where: { id: tarjetaId } }),
      prisma.debtCardInstallment.findMany({ where: { tarjetaId } }),
    ])

    res.json({
      success: true,
      tarjeta: tarjetaActualizada ? {
        id: tarjetaActualizada.id,
        nombre: tarjetaActualizada.nombre,
        saldoRestante: Number(tarjetaActualizada.saldoRestante),
        cuotaPeriodo: cuotaEfectivaTarjeta(Number(tarjetaActualizada.cuotaPeriodo), installments),
      } : null,
      cuotasAgregadas: cuotas,
      incrementoCuota,
      montoTotalAgregado: monto,
    })
  } catch (error) {
    console.error('[PayWithCard]', error)
    res.status(500).json({ error: 'Error al pagar con tarjeta' })
  }
})

export default router
