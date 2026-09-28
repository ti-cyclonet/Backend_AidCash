import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { checkLimit } from '../middleware/limit-enforcement.js'
import { recordMissionAction, recordOnboardingAction } from '../lib/missions.js'
import { getPeriodo, getNextPeriodo, getMontoPorPeriodo, parseDiasPago, esPendienteProximoPeriodo } from '../lib/period.js'
import { buildInstallmentRevertOps } from '../lib/installments.js'
import { fixedPeriodo, fixedPeriodoSiguiente, payFixedExpenseServer, fixedPeriodosRevisables, calcularAtrasosFijo, PeriodoFijoInvalidoError } from '../lib/fixed-expense-payments.js'
import { resumenPagosPeriodo } from '../lib/debt-calc.js'
import type { FixedExpensePayment, Prisma } from '@prisma/client'

// ─── Estado derivado por periodo (mismo patrón que debts.routes.ts) ────────────

function fixedStatus(payments: FixedExpensePayment[], periodo: string): { montoPagadoEstePeriodo: number } {
  const total = payments.filter(p => p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
  return { montoPagadoEstePeriodo: total }
}

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  monto: z.number().min(0),
  fechaCorte: z.string().min(1),
  categoria: z.enum(['vivienda', 'servicios', 'internet', 'transporte', 'educacion', 'salud', 'suscripciones', 'otro']).optional(),
  frecuencia: z.enum(['mensual', 'quincenal', 'semanal', 'anual']).optional(),
  metodoPago: z.string().optional(),
  renovacionAuto: z.boolean().optional(),
  pagoAutomatico: z.boolean().optional(),
  // Si el usuario confirma que la cuota de ESTE periodo ya la pagó (por fuera
  // de Kiri, antes de registrar el gasto), sembramos un FixedExpensePayment
  // marcador — mismo patrón que en debts.routes.ts POST /debts.
  yaPagoEstePeriodo: z.boolean().optional(),
  // Tercera opción del mismo prompt: la obligación es NUEVA y su primer cobro
  // real es el próximo periodo (ej. "día de pago: 4" creada el día 15) — no
  // pagada, no vencida, simplemente no aplica todavía. Mutuamente excluyente
  // con yaPagoEstePeriodo (ver handler).
  nuevaProximoPeriodo: z.boolean().optional(),
  // Antes faltaba acá — el formulario de creación ya deja elegir tarjeta,
  // pero el schema la descartaba silenciosamente y el gasto nacía sin vínculo.
  tarjetaVinculadaId: z.string().nullable().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
})

const updateSchema = z.object({
  nombre: z.string().min(1).optional(),
  monto: z.number().min(0).optional(),
  fechaCorte: z.string().optional(),
  categoria: z.enum(['vivienda', 'servicios', 'internet', 'transporte', 'educacion', 'salud', 'suscripciones', 'otro']).optional(),
  frecuencia: z.enum(['mensual', 'quincenal', 'semanal', 'anual']).optional(),
  metodoPago: z.string().nullable().optional(),
  renovacionAuto: z.boolean().optional(),
  tarjetaVinculadaId: z.string().nullable().optional(),
  pagoAutomatico: z.boolean().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
  // Respuesta a "¿ya pagaste la cuota de este periodo?" al editar — mismo
  // significado que en PATCH /debts/:id.
  yaPagoEstePeriodo: z.boolean().optional(),
  nuevaProximoPeriodo: z.boolean().optional(),
}).strict()

const undoPaySchema = z.object({
  alcance: z.enum(['ultimo', 'todo']).default('todo'),
  periodo: z.enum(['actual', 'siguiente']).default('actual'),
}).default({})

// ─── GET /fixed-expenses ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const fixedExpenses = await prisma.fixedExpense.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })

    // Pagos de los periodos que se necesitan (actual, siguiente y los ya
    // cerrados que se revisan por atrasos) en una sola query — por periodo y
    // no por fecha de creación: una cuota atrasada puede pagarse semanas después.
    const periodos = [...new Set(fixedExpenses.flatMap(f => [fixedPeriodo(f), fixedPeriodoSiguiente(f), ...fixedPeriodosRevisables(f)]))]
    const recentPayments = fixedExpenses.length > 0
      ? await prisma.fixedExpensePayment.findMany({
          where: { fixedExpenseId: { in: fixedExpenses.map(f => f.id) }, periodo: { in: periodos } },
        })
      : []
    const paymentsByExpense = new Map<string, FixedExpensePayment[]>()
    for (const p of recentPayments) {
      const arr = paymentsByExpense.get(p.fixedExpenseId) ?? []
      arr.push(p)
      paymentsByExpense.set(p.fixedExpenseId, arr)
    }

    res.json({
      fixedExpenses: fixedExpenses.map(f => {
        const periodo = fixedPeriodo(f)
        const montoPorPeriodo = getMontoPorPeriodo(Number(f.monto), f.frecuencia)
        const { montoPagadoEstePeriodo } = fixedStatus(paymentsByExpense.get(f.id) ?? [], periodo)
        const periodoSiguiente = fixedPeriodoSiguiente(f)
        const { montoPagadoEstePeriodo: montoAdelantado } = fixedStatus(paymentsByExpense.get(f.id) ?? [], periodoSiguiente)
        const atrasos = calcularAtrasosFijo(f, paymentsByExpense.get(f.id) ?? [])
        return {
          ...f,
          pagadoEstePeriodo: montoPagadoEstePeriodo >= montoPorPeriodo,
          montoPagadoEstePeriodo: montoPagadoEstePeriodo > 0 ? montoPagadoEstePeriodo : null,
          pendienteProximoPeriodo: esPendienteProximoPeriodo(f.activoDesdePeriodo, periodo),
          pagosPeriodo: resumenPagosPeriodo(paymentsByExpense.get(f.id) ?? [], periodo),
          periodoSiguiente,
          montoAdelantado: montoAdelantado > 0 ? montoAdelantado : null,
          proximaCuotaCubierta: montoAdelantado >= montoPorPeriodo && montoAdelantado > 0,
          atrasos,
          montoAtrasado: Math.round(atrasos.reduce((s, a) => s + a.falta, 0) * 100) / 100,
        }
      }),
    })
  } catch (error) {
    console.error('[GetFixed]', error)
    res.status(500).json({ error: 'Error al obtener gastos fijos' })
  }
})

// ─── POST /fixed-expenses ─────────────────────────────────────────────────────

router.post('/', validate(createSchema), checkLimit('nGastosFijos'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, monto, fechaCorte, categoria, frecuencia, metodoPago, renovacionAuto, pagoAutomatico, yaPagoEstePeriodo, nuevaProximoPeriodo, tarjetaVinculadaId, budgetCategoryId } = req.body
    const frecuenciaFinal = frecuencia ?? 'mensual'

    const expenseData = {
      userId, nombre, monto, fechaCorte,
      categoria: categoria ?? 'otro',
      frecuencia: frecuenciaFinal,
      metodoPago: metodoPago ?? null,
      renovacionAuto: renovacionAuto ?? false,
      pagoAutomatico: pagoAutomatico ?? false,
      tarjetaVinculadaId: tarjetaVinculadaId || null,
      budgetCategoryId: budgetCategoryId || null,
      // "Es una obligación nueva, inicia el próximo periodo" — no pagada, no
      // vencida: se guarda el periodo desde el que sí aplica y el pago/vencido
      // de HOY se ignora hasta llegar ahí (ver GET/PATCH más abajo). Mutuamente
      // excluyente con yaPagoEstePeriodo (no tendría sentido marcar ambas).
      activoDesdePeriodo: (nuevaProximoPeriodo && !yaPagoEstePeriodo)
        ? getNextPeriodo(frecuenciaFinal, parseDiasPago(fechaCorte))
        : null,
    }

    // Si ya pagó la cuota de este periodo, sembrar el pago marcador junto con
    // la creación — sin esto, el gasto nace "vencido" con un día que en
    // realidad ya está resuelto.
    const expense = yaPagoEstePeriodo
      ? await prisma.$transaction(async tx => {
          const created = await tx.fixedExpense.create({ data: expenseData })
          await tx.fixedExpensePayment.create({
            data: {
              fixedExpenseId: created.id,
              montoPagado: getMontoPorPeriodo(monto, frecuenciaFinal),
              periodo: fixedPeriodo(created),
              esMarcador: true,
            },
          })
          return created
        })
      : await prisma.fixedExpense.create({ data: expenseData })

    await recordOnboardingAction(userId, 'registrar_obligacion')

    res.status(201).json({
      fixedExpense: {
        ...expense,
        pagadoEstePeriodo: !!yaPagoEstePeriodo,
        montoPagadoEstePeriodo: yaPagoEstePeriodo ? getMontoPorPeriodo(monto, frecuenciaFinal) : null,
        pendienteProximoPeriodo: esPendienteProximoPeriodo(expense.activoDesdePeriodo, fixedPeriodo(expense)),
        pagosPeriodo: yaPagoEstePeriodo
          ? { cantidad: 1, ultimoMonto: getMontoPorPeriodo(monto, frecuenciaFinal), ultimoEsMarcador: true }
          : { cantidad: 0, ultimoMonto: null, ultimoEsMarcador: false },
      },
    })
  } catch (error) {
    console.error('[CreateFixed]', error)
    res.status(500).json({ error: 'Error al crear gasto fijo' })
  }
})

// ─── PATCH /fixed-expenses/:id ────────────────────────────────────────────────

router.patch('/:id', validate(updateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    const { yaPagoEstePeriodo, nuevaProximoPeriodo, ...fields } = req.body as z.infer<typeof updateSchema>
    const data: Prisma.FixedExpenseUncheckedUpdateInput = { ...fields }

    const frecuenciaFinal = fields.frecuencia ?? existing.frecuencia
    const fechaCorteFinal = fields.fechaCorte ?? existing.fechaCorte
    if (nuevaProximoPeriodo !== undefined) {
      data.activoDesdePeriodo = nuevaProximoPeriodo && !yaPagoEstePeriodo
        ? getNextPeriodo(frecuenciaFinal, parseDiasPago(fechaCorteFinal))
        : null
    }

    const periodoAnterior = fixedPeriodo(existing)
    const periodo = fixedPeriodo({ frecuencia: frecuenciaFinal, fechaCorte: fechaCorteFinal })

    const expense = await prisma.$transaction(async tx => {
      const updated = await tx.fixedExpense.update({ where: { id }, data })

      // Cambiar frecuencia/días cambia la etiqueta del periodo en curso — lo
      // ya pagado en él debe seguir contando (ver misma nota en PATCH /debts/:id).
      if (periodo !== periodoAnterior) {
        await tx.fixedExpensePayment.updateMany({ where: { fixedExpenseId: id, periodo: periodoAnterior }, data: { periodo } })
      }

      if (yaPagoEstePeriodo) {
        const montoPorPeriodo = getMontoPorPeriodo(Number(updated.monto), updated.frecuencia)
        const prev = await tx.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
        const falta = Math.round((montoPorPeriodo - prev.reduce((s, p) => s + Number(p.montoPagado), 0)) * 100) / 100
        if (falta > 0) {
          await tx.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: falta, periodo, esMarcador: true } })
        }
      }
      return updated
    })

    if (fields.categoria) {
      await recordMissionAction(userId, 'categorizar')
    }

    const montoPorPeriodo = getMontoPorPeriodo(Number(expense.monto), expense.frecuencia)
    const payments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
    const { montoPagadoEstePeriodo } = fixedStatus(payments, periodo)

    res.json({
      fixedExpense: {
        ...expense,
        pagadoEstePeriodo: montoPagadoEstePeriodo >= montoPorPeriodo,
        montoPagadoEstePeriodo: montoPagadoEstePeriodo > 0 ? montoPagadoEstePeriodo : null,
        pendienteProximoPeriodo: esPendienteProximoPeriodo(expense.activoDesdePeriodo, periodo),
        pagosPeriodo: resumenPagosPeriodo(payments, periodo),
      },
    })
  } catch (error) {
    console.error('[UpdateFixed]', error)
    res.status(500).json({ error: 'Error al actualizar gasto fijo' })
  }
})

// ─── PATCH /fixed-expenses/:id/pay — Pagar con lógica de tarjeta vinculada ────
// Si el gasto fijo tiene una tarjeta vinculada:
//   → Suma el monto al saldo_principal de esa tarjeta (como si compraras con TC)
//   → NO descuenta del cashBalance (la tarjeta "paga" por ti)
// Si NO tiene tarjeta:
//   → Proceso normal de pago (descuenta del cashBalance)

const payFixedSchema = z.object({
  monto: z.number().min(0.01).optional(),
  // 'actual' | 'siguiente' (adelantar) | periodo de una cuota atrasada, ej. "2026-08"
  periodo: z.string().min(1).optional(),
  // "Con este valor quedó pagada la cuota del periodo"
  cuotaCompleta: z.boolean().optional(),
}).strict()

const marcarPagadoSchema = z.object({ periodo: z.string().min(1) })

router.patch('/:id/pay', validate(payFixedSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const result = await payFixedExpenseServer(userId, id, req.body.monto, req.body.periodo ?? 'actual', !!req.body.cuotaCompleta)
    if (!result) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    res.json(result)
  } catch (error) {
    if (error instanceof PeriodoFijoInvalidoError) {
      res.status(400).json({ error: error.message })
      return
    }
    console.error('[PayFixed]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── POST /fixed-expenses/:id/marcar-pagado ───────────────────────────────────
// "Esa cuota atrasada ya la había pagado por fuera de Kiri" — marcador que no
// toca la billetera (mismo que en POST /debts/:id/marcar-pagado).

router.post('/:id/marcar-pagado', validate(marcarPagadoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { periodo } = req.body as z.infer<typeof marcarPagadoSchema>
    const fe = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!fe) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }
    if (!fixedPeriodosRevisables(fe).includes(periodo)) {
      res.status(400).json({ error: 'Solo se pueden marcar cuotas de periodos ya cerrados' })
      return
    }
    const pagos = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo } })
    const atraso = calcularAtrasosFijo(fe, pagos)[0]
    if (!atraso) {
      res.status(400).json({ error: 'Esa cuota no está atrasada' })
      return
    }
    await prisma.fixedExpensePayment.create({ data: { fixedExpenseId: id, montoPagado: atraso.falta, periodo, esMarcador: true } })
    res.json({ ok: true })
  } catch (error) {
    console.error('[MarcarPagadoFixed]', error)
    res.status(500).json({ error: 'Error al marcar la cuota' })
  }
})

// ─── POST /fixed-expenses/:id/undo-pay ────────────────────────────────────────
// Revierte el pago de un gasto fijo. Devuelve el monto al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', validate(undoPaySchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    // Solo se puede deshacer un pago dentro del periodo actual — un pago de un
    // periodo ya cerrado no se puede tocar (no hay columna mutable que "recuerde"
    // otra cosa).
    const periodo = req.body.periodo === 'siguiente' ? fixedPeriodoSiguiente(existing) : fixedPeriodo(existing)
    const payments = await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: id, periodo }, orderBy: { createdAt: 'desc' } })
    if (payments.length === 0) {
      res.status(400).json({ error: 'Este gasto no tiene pagos registrados' })
      return
    }

    // 'ultimo' deshace solo el pago más reciente del periodo (ej. un abono
    // extra) y deja el resto — ver misma lógica en POST /debts/:id/undo-pay.
    const alcance: 'ultimo' | 'todo' = req.body.alcance
    const aDeshacer = alcance === 'ultimo' ? payments.slice(0, 1) : payments
    const restantes = payments.slice(aDeshacer.length)

    // Cada pago dice por sí mismo si salió en efectivo o de una tarjeta
    // (tarjetaVinculada permanente o un pay-with-card puntual) — ya no hace
    // falta adivinar por el vínculo del gasto fijo, que solo cubría un caso.
    // Los marcadores ("ya lo había pagado por fuera") no devuelven nada:
    // nunca salió plata de la billetera por ellos.
    const cashPayments = aDeshacer.filter(p => !p.tarjetaId && !p.esMarcador)
    const cardPayments = aDeshacer.filter(p => p.tarjetaId)
    const montoDevolver = cashPayments.reduce((s, p) => s + Number(p.montoPagado), 0)

    // Dos tipos de pago con tarjeta muy distintos acá: el vínculo PERMANENTE
    // (tarjetaVinculadaId, ej. Netflix siempre con esta TC) suma directo al
    // saldo sin crear un plan de cuotas — se revierte con un decrement simple.
    // El pay-with-card puntual SÍ crea un DebtCardInstallment con su propio
    // montoAbonado — ese necesita buildInstallmentRevertOps para no perder de
    // vista lo que ya se le hubiera abonado a ese plan específico.
    const linkedCardPayments = cardPayments.filter(p => !p.installmentId)
    const installmentIds = [...new Set(cardPayments.filter(p => p.installmentId).map(p => p.installmentId!))]

    const montoPorTarjetaVinculada = new Map<string, number>()
    for (const p of linkedCardPayments) {
      montoPorTarjetaVinculada.set(p.tarjetaId!, (montoPorTarjetaVinculada.get(p.tarjetaId!) ?? 0) + Number(p.montoPagado))
    }

    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.fixedExpensePayment.deleteMany({ where: { id: { in: aDeshacer.map(p => p.id) } } }),
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
    for (const [tarjetaId, monto] of montoPorTarjetaVinculada) {
      ops.push(prisma.debt.update({
        where: { id: tarjetaId },
        data: {
          saldoRestante: { decrement: monto },
          saldoPrincipal: { decrement: monto },
        },
      }))
    }
    ops.push(...(await buildInstallmentRevertOps(userId, installmentIds)))

    await prisma.$transaction(ops)

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true, walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
    })

    const montoPorPeriodo = getMontoPorPeriodo(Number(existing.monto), existing.frecuencia)
    const { montoPagadoEstePeriodo } = fixedStatus(restantes, periodo)

    res.json({
      fixedExpense: {
        ...existing,
        pagadoEstePeriodo: montoPagadoEstePeriodo >= montoPorPeriodo,
        montoPagadoEstePeriodo: montoPagadoEstePeriodo > 0 ? montoPagadoEstePeriodo : null,
        pendienteProximoPeriodo: esPendienteProximoPeriodo(existing.activoDesdePeriodo, periodo),
        pagosPeriodo: resumenPagosPeriodo(restantes, periodo),
      },
      montoDevuelto: montoDevolver,
      pagosDeshechos: aDeshacer.length,
      revertidoDeTarjeta: cardPayments.length > 0
        ? [...new Set(cardPayments.map(p => p.tarjetaId!))].map(tarjetaId => ({ tarjetaId }))
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
    console.error('[UndoPayFixed]', error)
    res.status(500).json({ error: 'Error al deshacer pago de gasto fijo' })
  }
})

// ─── DELETE /fixed-expenses/:id ───────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.fixedExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto fijo no encontrado' })
      return
    }

    await prisma.fixedExpense.delete({ where: { id } })
    res.json({ message: 'Gasto fijo eliminado' })
  } catch (error) {
    console.error('[DeleteFixed]', error)
    res.status(500).json({ error: 'Error al eliminar gasto fijo' })
  }
})

export default router
