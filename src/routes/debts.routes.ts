import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { nombreRequerido, diasDelMes } from '../lib/validacion.js'
import { checkLimit, attachUsageWarning, respuestaFuncion } from '../middleware/limit-enforcement.js'
import { resolverPlan } from '../lib/planes.js'
import { recordOnboardingAction, recordMissionAction } from '../lib/missions.js'
import { getPeriodo, getNextPeriodo, getMontoPorPeriodo, parseDiasPago, esPendienteProximoPeriodo } from '../lib/period.js'
import { cuotaEfectivaTarjeta, reverseCardPaymentAllocations, buildInstallmentRevertOps } from '../lib/installments.js'
import { debtPeriodo, debtPeriodoSiguiente, computePeriodStatus, calcularPagoDeuda, calcularAtrasos, cuotaBaseDelPeriodo, periodosRevisables, tasaDelPeriodo } from '../lib/debt-calc.js'
import { payDebtServer, PeriodoInvalidoError, PagoExcedeSaldoError } from '../lib/debt-payments.js'
import { cargarContextoDeudas, serializarDeuda, serializarUnaDeuda } from '../lib/debt-view.js'
import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createDebtSchema = z.object({
  nombre: nombreRequerido,
  montoTotal: z.number().min(0.01),
  saldoRestante: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0.01),
  acreedor: z.string().trim().max(120).default(''),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).default('mensual'),
  diasPago: diasDelMes.default('1'), // "15" o "15,30"
  tasaInteres: z.number().min(0).max(999, 'La tasa de interés no puede pasar de 999%').optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).default('media'),
  bankEntityId: z.string().uuid().nullable().optional(),
  tipoDeuda: z.enum(['PRESTAMO', 'TARJETA_CREDITO']).default('PRESTAMO'),
  // Si el usuario confirma que la cuota de ESTE periodo ya la pagó (por fuera
  // de Kiri, antes de registrar la deuda), sembramos un DebtPayment marcador
  // para que no salga "vencida" con una fecha que ya está resuelta — ver
  // handler de POST / más abajo.
  yaPagoEstePeriodo: z.boolean().optional(),
  // Tercera opción del mismo prompt (ver fixed-expenses.routes.ts): la deuda
  // es NUEVA y su primer cobro real es el próximo periodo — no pagada, no
  // vencida. Mutuamente excluyente con yaPagoEstePeriodo.
  nuevaProximoPeriodo: z.boolean().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
  // Deuda compartida (Social > Deudas, solo pareja/familia) — validados abajo
  // en el handler: si esCompartida es true, connectionId y los dos montos son
  // requeridos y deben sumar exactamente montoTotal.
  esCompartida: z.boolean().optional(),
  connectionId: z.string().uuid().optional(),
  montoParticipanteA: z.number().min(0).optional(),
  montoParticipanteB: z.number().min(0).optional(),
})

const updateDebtSchema = z.object({
  nombre: nombreRequerido.optional(),
  montoTotal: z.number().min(0).optional(),
  saldoRestante: z.number().min(0).optional(),
  cuotaPeriodo: z.number().min(0).optional(),
  acreedor: z.string().trim().max(120).optional(),
  frecuenciaPago: z.enum(['mensual', 'quincenal']).optional(),
  diasPago: diasDelMes.optional(),
  tasaInteres: z.number().min(0).max(999, 'La tasa de interés no puede pasar de 999%').nullable().optional(),
  prioridad: z.enum(['alta', 'media', 'baja']).optional(),
  estado: z.enum(['activa', 'saldada', 'vencida']).optional(),
  pagoAutomatico: z.boolean().optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
  // Respuesta a "¿ya pagaste la cuota de este periodo?" — el formulario de
  // edición la pregunta cuando, con los datos editados, la deuda quedaría
  // vencida este periodo (ej. se movió el día de pago a uno que ya pasó). Sin
  // esto, editar el día de una deuda "nueva, inicia el próximo mes" o de una
  // ya pagada por fuera la dejaba marcada vencida sin forma de corregirlo.
  // `nuevaProximoPeriodo: false` explícito significa "sí está vencida".
  yaPagoEstePeriodo: z.boolean().optional(),
  nuevaProximoPeriodo: z.boolean().optional(),
  // "Solo este mes": la cuota del periodo ACTUAL cambia a este valor y el
  // siguiente vuelve sola a `cuotaPeriodo`. Antes esa opción del formulario
  // no enviaba nada y el cambio se perdía en silencio.
  cuotaSoloEstePeriodo: z.number().min(0.01).optional(),
}).strict()

const undoPaySchema = z.object({
  // 'ultimo' = solo el pago más reciente del periodo (ej. un abono extra);
  // 'todo' = todos los pagos del periodo (comportamiento de siempre).
  alcance: z.enum(['ultimo', 'todo']).default('todo'),
  // 'siguiente' = deshacer lo adelantado a la próxima cuota.
  periodo: z.enum(['actual', 'siguiente']).default('actual'),
}).default({})

const payDebtSchema = z.object({
  monto: z.number().min(0.01).optional(), // Si no se envía, usa la cuota (o lo que falte de ella)
  // 'actual' | 'siguiente' (adelantar la próxima cuota) | periodo de una cuota atrasada, ej. "2026-08"
  periodo: z.string().min(1).optional(),
  // Saldo que quedó según el banco (opcional) — ver OpcionesPago en lib/debt-payments.ts
  saldoReal: z.number().min(0).optional(),
  // "Con este valor quedó pagada la cuota del periodo"
  cuotaCompleta: z.boolean().optional(),
})

const marcarPagadoSchema = z.object({
  periodo: z.string().min(1),
})

// ─── GET /debts ───────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const estado = (req.query.estado as string) || 'activa'

    const debts = await prisma.debt.findMany({ where: { userId, estado }, orderBy: { createdAt: 'desc' } })

    const ctx = await cargarContextoDeudas(debts)

    // Nombre del participante B para las deudas compartidas — normalmente muy
    // pocas por usuario, se resuelve en una sola query aparte en vez de un
    // include general en el findMany de arriba (que no lo necesita casi nunca).
    const compartidaIds = debts.filter(d => d.esCompartida && d.connectionId).map(d => d.connectionId as string)
    const connections = compartidaIds.length > 0
      ? await prisma.connection.findMany({
          where: { id: { in: compartidaIds } },
          include: { requester: { select: { nombre: true } }, addressee: { select: { nombre: true } } },
        })
      : []
    const peerNameByConnection = new Map<string, string>()
    for (const c of connections) {
      // El dueño de la deuda (userId) es siempre requester o addressee — el
      // "participante B" es la otra persona de esa misma conexión.
      const peerName = c.requesterId === userId ? c.addressee.nombre : c.requester.nombre
      peerNameByConnection.set(c.id, peerName)
    }

    res.json({
      debts: debts.map(d => serializarDeuda(d, ctx, {
        nombreParticipanteB: d.connectionId ? peerNameByConnection.get(d.connectionId) ?? null : null,
      })),
    })
  } catch (error) {
    console.error('[GetDebts]', error)
    res.status(500).json({ error: 'Error al obtener deudas' })
  }
})

// ─── GET /debts/shared — Deudas compartidas visibles en Social > Deudas ───────
// Visible para AMBOS lados de la conexión: el dueño (userId) y su pareja/
// familiar — es solo informativa, ninguno de los dos paga desde acá.

router.get('/shared', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const debts = await prisma.debt.findMany({
      where: {
        esCompartida: true,
        OR: [
          { userId },
          { connection: { OR: [{ requesterId: userId }, { addresseeId: userId }] } },
        ],
      },
      include: {
        user: { select: { nombre: true } },
        connection: {
          select: {
            role: true,
            requesterId: true,
            addresseeId: true,
            requester: { select: { nombre: true } },
            addressee: { select: { nombre: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      debts: debts.filter(d => d.connection).map(d => {
        const conn = d.connection!
        const isOwner = d.userId === userId
        const otherName = conn.requesterId === d.userId ? conn.addressee.nombre : conn.requester.nombre
        return {
          id: d.id,
          nombre: d.nombre,
          montoTotal: Number(d.montoTotal),
          // Lo que falta y la cuota — una deuda antigua se registra con lo que
          // ya habían pagado, así los dos ven el avance real
          saldoRestante: Number(d.saldoRestante),
          cuotaPeriodo: Number(d.cuotaPeriodo),
          frecuenciaPago: d.frecuenciaPago,
          diasPago: d.diasPago,
          tipoDeuda: d.tipoDeuda,
          tasaInteres: d.tasaInteres ? Number(d.tasaInteres) : null,
          estado: d.estado,
          connectionRole: conn.role,
          isOwner,
          ownerName: d.user.nombre,
          peerName: otherName,
          // Monto de cada uno, siempre relativo a quién es dueño de la deuda —
          // montoParticipanteA es el del dueño, montoParticipanteB el del peer.
          ownerShare: Number(d.montoParticipanteA ?? 0),
          peerShare: Number(d.montoParticipanteB ?? 0),
          myShare: isOwner ? Number(d.montoParticipanteA ?? 0) : Number(d.montoParticipanteB ?? 0),
          createdAt: d.createdAt,
        }
      }),
    })
  } catch (error) {
    console.error('[GetSharedDebts]', error)
    res.status(500).json({ error: 'Error al obtener deudas compartidas' })
  }
})

// ─── POST /debts ──────────────────────────────────────────────────────────────

router.post('/', validate(createDebtSchema), checkLimit('nDeudas'), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { nombre, montoTotal, saldoRestante, cuotaPeriodo, acreedor, frecuenciaPago, diasPago, tasaInteres, prioridad, bankEntityId, tipoDeuda, yaPagoEstePeriodo, nuevaProximoPeriodo, budgetCategoryId, esCompartida, connectionId, montoParticipanteA, montoParticipanteB } = req.body
    const frecuenciaFinal = frecuenciaPago || 'mensual'

    // Deuda compartida — la deuda sigue siendo 100% de `userId` (mismos pagos
    // de siempre); connectionId + los dos montos son solo informativos para
    // mostrar "compartida con X" en Obligaciones y en Social > Deudas.
    let compartidaData: {
      esCompartida: boolean
      connectionId: string | null
      montoParticipanteA: number | null
      montoParticipanteB: number | null
    } = { esCompartida: false, connectionId: null, montoParticipanteA: null, montoParticipanteB: null }

    if (esCompartida) {
      const plan = await resolverPlan(req.user!.userId)
      if (!plan.features.sharedDebts && plan.fuente !== 'sin_conexion') {
        res.status(403).json(respuestaFuncion(plan, 'sharedDebts'))
        return
      }
      if (!connectionId || montoParticipanteA == null || montoParticipanteB == null) {
        res.status(400).json({ error: 'Falta la conexión o los montos de cada participante' })
        return
      }
      const conn = await prisma.connection.findFirst({
        where: {
          id: connectionId,
          status: 'ACCEPTED',
          role: { in: ['PARTNER', 'FAMILY'] },
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
      })
      if (!conn) {
        res.status(400).json({ error: 'La conexión debe ser una pareja o familiar aceptado' })
        return
      }
      if (Math.abs(montoParticipanteA + montoParticipanteB - montoTotal) > 0.01) {
        res.status(400).json({ error: 'La suma de los dos montos debe ser igual al monto total' })
        return
      }
      compartidaData = { esCompartida: true, connectionId, montoParticipanteA, montoParticipanteB }
    }

    const debtData = {
      userId,
      nombre,
      tipoDeuda: tipoDeuda || 'PRESTAMO',
      montoTotal,
      // Si el usuario ingresó un saldo actual diferente (ya venía pagando), usarlo
      saldoRestante: saldoRestante ?? montoTotal,
      montoInicial: montoTotal,
      cuotaPeriodo,
      acreedor: acreedor || '',
      frecuenciaPago: frecuenciaFinal,
      diasPago: diasPago || '1',
      tasaInteres: tasaInteres ?? null,
      tasaInteresAplicada: tasaInteres ?? null,
      prioridad: prioridad || 'media',
      estado: 'activa' as const,
      fechaInicio: new Date(),
      bankEntityId: bankEntityId || null,
      budgetCategoryId: budgetCategoryId || null,
      // "Es una obligación nueva, inicia el próximo periodo" — ver misma nota
      // en fixed-expenses.routes.ts. Mutuamente excluyente con yaPagoEstePeriodo.
      activoDesdePeriodo: (nuevaProximoPeriodo && !yaPagoEstePeriodo)
        ? getNextPeriodo(frecuenciaFinal, parseDiasPago(diasPago || '1'))
        : null,
      ...compartidaData,
    }

    // Si el usuario confirma que la cuota de este periodo ya está pagada (la
    // pagó antes de registrar la deuda en Kiri), sembramos un DebtPayment
    // marcador junto con la deuda para que el periodo actual no salga
    // "vencido" — sin tocar el saldo (no es un pago real ocurriendo ahora,
    // el `saldoRestante` de arriba ya refleja lo que el usuario debe hoy) ni
    // descontar de la billetera (a diferencia de POST /:id/pay).
    const debt = yaPagoEstePeriodo
      ? await prisma.$transaction(async tx => {
          const created = await tx.debt.create({ data: debtData })
          await tx.debtPayment.create({
            data: {
              debtId: created.id,
              montoPagado: cuotaPeriodo,
              abonoCapital: 0,
              pagoInteres: 0,
              saldoAnterior: created.saldoRestante,
              saldoPosterior: created.saldoRestante,
              periodo: debtPeriodo(created),
              esMarcador: true,
            },
          })
          return created
        })
      : await prisma.debt.create({ data: debtData })

    await recordOnboardingAction(userId, 'registrar_obligacion')

    res.status(201).json({
      debt: {
        ...debt,
        montoTotal: Number(debt.montoTotal),
        saldoRestante: Number(debt.saldoRestante),
        cuotaPeriodo: Number(debt.cuotaPeriodo),
        tasaInteres: debt.tasaInteres ? Number(debt.tasaInteres) : null,
        pagadoEstePeriodo: !!yaPagoEstePeriodo,
        montoPagadoEstePeriodo: yaPagoEstePeriodo ? Number(cuotaPeriodo) : null,
        montoParticipanteA: debt.montoParticipanteA ? Number(debt.montoParticipanteA) : null,
        montoParticipanteB: debt.montoParticipanteB ? Number(debt.montoParticipanteB) : null,
        pendienteProximoPeriodo: esPendienteProximoPeriodo(debt.activoDesdePeriodo, debtPeriodo(debt)),
        pagosPeriodo: yaPagoEstePeriodo
          ? { cantidad: 1, ultimoMonto: Number(cuotaPeriodo), ultimoEsMarcador: true }
          : { cantidad: 0, ultimoMonto: null, ultimoEsMarcador: false },
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

    const result = await payDebtServer(userId, id, req.body.monto, req.body.periodo ?? 'actual', {
      saldoReal: req.body.saldoReal,
      cuotaCompleta: req.body.cuotaCompleta,
    })
    if (!result) {
      res.status(404).json({ error: 'Deuda activa no encontrada' })
      return
    }

    res.json(result)
  } catch (error) {
    if (error instanceof PeriodoInvalidoError) {
      res.status(400).json({ error: error.message })
      return
    }
    if (error instanceof PagoExcedeSaldoError) {
      res.status(400).json({ error: error.message, codigo: 'PAGO_EXCEDE_SALDO', maximo: error.maximo })
      return
    }
    console.error('[PayDebt]', error)
    res.status(500).json({ error: 'Error al registrar pago' })
  }
})

// ─── POST /debts/:id/marcar-pagado ────────────────────────────────────────────
// "Esa cuota atrasada ya la había pagado por fuera de Kiri": deja el periodo
// cubierto con un pago marcador (no toca saldo ni billetera) — mismo marcador
// que "ya la pagué" al crear/editar. Sin esto, una deuda registrada hace meses
// y pagada por fuera mostraría cuotas "atrasadas" que no existen.

router.post('/:id/marcar-pagado', validate(marcarPagadoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const { periodo } = req.body as z.infer<typeof marcarPagadoSchema>

    const debt = await prisma.debt.findFirst({ where: { id, userId, estado: 'activa' } })
    if (!debt) {
      res.status(404).json({ error: 'Deuda activa no encontrada' })
      return
    }
    if (!periodosRevisables(debt).includes(periodo)) {
      res.status(400).json({ error: 'Solo se pueden marcar cuotas de periodos ya cerrados' })
      return
    }
    const pagos = await prisma.debtPayment.findMany({ where: { debtId: id, periodo } })
    const atraso = calcularAtrasos(debt, pagos)[0]
    if (!atraso) {
      res.status(400).json({ error: 'Esa cuota no está atrasada' })
      return
    }

    await prisma.debtPayment.create({
      data: {
        debtId: id,
        montoPagado: atraso.falta,
        abonoCapital: 0,
        pagoInteres: 0,
        saldoAnterior: debt.saldoRestante,
        saldoPosterior: debt.saldoRestante,
        periodo,
        esMarcador: true,
      },
    })

    res.json({ debt: await serializarUnaDeuda(id) })
  } catch (error) {
    console.error('[MarcarPagadoDebt]', error)
    res.status(500).json({ error: 'Error al marcar la cuota' })
  }
})

// ─── POST /debts/:id/undo-pay ─────────────────────────────────────────────────
// Revierte un pago de cuota. Devuelve el monto al saldoRestante y al cashBalance.
// Usa $transaction para garantizar consistencia atómica.

router.post('/:id/undo-pay', validate(undoPaySchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string
    const alcance: 'ultimo' | 'todo' = req.body.alcance
    const destino: 'actual' | 'siguiente' = req.body.periodo

    // Buscar deuda del usuario
    const existing = await prisma.debt.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Deuda no encontrada' })
      return
    }

    // Solo se puede deshacer un pago que quede DENTRO del periodo actual de la
    // deuda — al no haber columnas mutables, el periodo es lo único que define
    // "el pago más reciente"; un pago de un periodo ya cerrado no se puede tocar.
    const periodo = destino === 'siguiente' ? debtPeriodoSiguiente(existing) : debtPeriodo(existing)
    const payments = await prisma.debtPayment.findMany({
      where: { debtId: id, periodo },
      orderBy: { createdAt: 'desc' },
    })
    if (payments.length === 0) {
      res.status(404).json({ error: 'No hay pagos registrados para deshacer' })
      return
    }

    // 'ultimo' deshace solo el pago más reciente (ej. el abono extra que se
    // hizo después de pagar la cuota) y deja el resto intacto. Siempre el más
    // reciente y nunca uno del medio: cada pago guarda el saldo/interés que
    // había justo antes, así que solo se puede "rebobinar" desde el final.
    const aDeshacer = alcance === 'ultimo' ? payments.slice(0, 1) : payments

    // El saldoRestante solo se redujo por el capital (no por intereses), así que
    // debemos devolver solo el CAPITAL al saldo, no el monto total pagado —
    // esto aplica sin importar cómo se pagó (efectivo o tarjeta).
    const totalCapitalAbonado = aDeshacer.reduce((sum, p) => sum + Number(p.abonoCapital), 0)

    // Separar los pagos entre efectivo y tarjeta: solo los de efectivo
    // devuelven dinero a cashBalance — los de tarjeta nunca lo tocaron, así
    // que revertirlos significa restarle a LA TARJETA (no sumarle a la
    // billetera) y borrar el plan de cuotas que generaron. Los marcadores
    // ("ya la había pagado por fuera") tampoco devuelven nada: nunca salió
    // plata de la billetera por ellos — antes se trataban como efectivo y
    // deshacerlos le REGALABA al usuario el valor de la cuota.
    const cashPayments = aDeshacer.filter(p => !p.tarjetaId && !p.esMarcador)
    const cardPayments = aDeshacer.filter(p => p.tarjetaId)
    const montoDevolver = cashPayments.reduce((sum, p) => sum + Number(p.montoPagado), 0)

    const installmentIds = new Set<string>()
    for (const p of cardPayments) {
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
    // Los pagos de OTRA(s) tarjeta(s) que financiaron esta deuda se revierten
    // por completo: le devuelven a esa tarjeta lo que aún no se había pagado
    // de su plan y acreditan a la billetera lo que sí se había abonado ya
    // (ver buildInstallmentRevertOps).
    ops.push(...(await buildInstallmentRevertOps(userId, [...installmentIds])))
    // Si `existing` es la propia tarjeta, los pagos en efectivo que se están
    // deshaciendo son pagos que ELLA MISMA repartió entre sus planes de cuotas
    // vigentes al registrarse — hay que devolverles ese montoAbonado antes de
    // borrar los DebtPayment (una vez borrados, la asignación se va en cascada
    // pero ya no se puede reconstruir cuánto corresponde a cada plan).
    if (existing.tipoDeuda === 'TARJETA_CREDITO') {
      ops.push(...(await reverseCardPaymentAllocations(cashPayments.map(p => p.id))))
    }
    ops.push(prisma.debtPayment.deleteMany({ where: { id: { in: aDeshacer.map(p => p.id) } } }))

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

    // La respuesta sale del serializador común: si `existing` es una tarjeta,
    // deshacer un pago pudo revivir planes de cuotas ya saldados y su cuota
    // efectiva cambia; con alcance 'ultimo' pueden quedar pagos en el periodo.
    res.json({
      debt: await serializarUnaDeuda(debt.id),
      montoDevuelto: montoDevolver,
      pagosDeshechos: aDeshacer.length,
      // El frontend solo usa esto como señal de "refresca todo" (la tarjeta
      // que financió este pago quedó con su saldo/cuota desactualizados en su
      // propia card hasta el próximo fetch) — no necesita el detalle exacto.
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

    const { yaPagoEstePeriodo, nuevaProximoPeriodo, cuotaSoloEstePeriodo, ...fields } = req.body as z.infer<typeof updateDebtSchema>

    // Al editar la tasa declarada, sincronizar también la tasa APLICADA — antes
    // quedaban desincronizadas (el pago siempre usa tasaInteresAplicada, que se
    // congelaba en el valor de creación y nunca se actualizaba desde acá).
    const data: Prisma.DebtUncheckedUpdateInput = { ...fields }
    if ('tasaInteres' in fields) {
      data.tasaInteresAplicada = fields.tasaInteres
    }

    const frecuenciaFinal = fields.frecuenciaPago ?? existing.frecuenciaPago
    const diasFinal = fields.diasPago ?? existing.diasPago
    if (nuevaProximoPeriodo !== undefined) {
      data.activoDesdePeriodo = nuevaProximoPeriodo && !yaPagoEstePeriodo
        ? getNextPeriodo(frecuenciaFinal, parseDiasPago(diasFinal))
        : null
    }

    const periodoAnterior = debtPeriodo(existing)
    const periodo = debtPeriodo({ frecuenciaPago: frecuenciaFinal, diasPago: diasFinal })

    if (cuotaSoloEstePeriodo !== undefined) {
      data.cuotaOverride = cuotaSoloEstePeriodo
      data.cuotaOverridePeriodo = periodo
    } else if (fields.cuotaPeriodo !== undefined) {
      // Cambio permanente de cuota: cualquier ajuste "solo este periodo" queda sin efecto.
      data.cuotaOverride = null
      data.cuotaOverridePeriodo = null
    } else if (existing.cuotaOverridePeriodo === periodoAnterior && periodo !== periodoAnterior) {
      // El periodo en curso cambió de etiqueta (otra frecuencia/días): el ajuste lo acompaña.
      data.cuotaOverridePeriodo = periodo
    }

    const installments = existing.tipoDeuda === 'TARJETA_CREDITO'
      ? await prisma.debtCardInstallment.findMany({ where: { tarjetaId: id } })
      : []

    const debt = await prisma.$transaction(async tx => {
      const updated = await tx.debt.update({ where: { id }, data })

      // Cambiar la frecuencia o los días de una quincenal cambia la etiqueta
      // del periodo en curso ("2026-09" → "2026-09-Q2", o la frontera Q1/Q2).
      // Lo que ya se pagó en el periodo en curso debe seguir contando — si
      // no, la deuda pasaba de "Pagada" a "Vencida" solo por editarla.
      if (periodo !== periodoAnterior) {
        await tx.debtPayment.updateMany({ where: { debtId: id, periodo: periodoAnterior }, data: { periodo } })
      }

      if (yaPagoEstePeriodo) {
        const cuotaVigente = updated.tipoDeuda === 'TARJETA_CREDITO'
          ? cuotaEfectivaTarjeta(cuotaBaseDelPeriodo(updated, periodo), installments, { tarjeta: updated, periodo })
          : cuotaBaseDelPeriodo(updated, periodo)
        const prev = await tx.debtPayment.findMany({ where: { debtId: id, periodo } })
        const falta = Math.round((cuotaVigente - prev.reduce((s, p) => s + Number(p.montoPagado), 0)) * 100) / 100
        if (falta > 0) {
          // Mismo marcador que POST / con yaPagoEstePeriodo: no toca saldo ni billetera.
          await tx.debtPayment.create({
            data: {
              debtId: id,
              montoPagado: falta,
              abonoCapital: 0,
              pagoInteres: 0,
              saldoAnterior: updated.saldoRestante,
              saldoPosterior: updated.saldoRestante,
              periodo,
              esMarcador: true,
            },
          })
        }
      }
      return updated
    })

    res.json({ debt: await serializarUnaDeuda(debt.id) })
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
      const { pagoInteres, abonoCapital, nuevoSaldo, nuevoEstado } = calcularPagoDeuda(currentSaldo, tasaDelPeriodo(tasaMensual, deuda.frecuenciaPago), status, montoPago)

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

    // Pagar con la tarjeta también es pagar la obligación (antes no contaba para la misión)
    await recordMissionAction(userId, 'pagar_obligacion')

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
        cuotaPeriodo: cuotaEfectivaTarjeta(cuotaBaseDelPeriodo(tarjetaActualizada, debtPeriodo(tarjetaActualizada)), installments, { tarjeta: tarjetaActualizada, periodo: debtPeriodo(tarjetaActualizada) }),
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
