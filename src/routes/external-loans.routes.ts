/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — "Me deben": préstamos a personas que no usan Kiri
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A diferencia de /loans (P2P entre dos usuarios de Kiri, con aprobación y
 * confirmación de cada abono), esto es el registro personal del que prestó:
 * la otra persona no necesita cuenta. Reglas de dinero:
 *  - Prestar con "salió de mi billetera" descuenta del gasto libre primero y,
 *    si no alcanza, del resto del disponible (ver planDeduccionEnCascada). Si
 *    tampoco alcanza el disponible total, se rechaza — el frontend ofrece
 *    sacar la diferencia de un bolsillo de ahorro antes de reintentar. Sin
 *    "salió de mi billetera" es un préstamo viejo que solo se anota.
 *  - Cada abono con "entró a mi billetera" vuelve al bolsillo libre.
 *  - Nada de esto es gasto ni ingreso: es dinero por cobrar.
 */
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { planPocketCredit, planPocketDeduction, planDeduccionEnCascada } from '../lib/wallet.js'
import type { ExternalLoan, ExternalLoanPayment, Prisma } from '@prisma/client'

const router = Router()
router.use(authMiddleware)

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')

const createSchema = z.object({
  persona: z.string().trim().min(1, '¿A quién le prestaste?').max(80),
  telefono: z.string().trim().max(20).optional().nullable(),
  monto: z.number().min(1),
  fechaPrestamo: fecha.optional(),
  fechaCompromiso: fecha.optional().nullable(),
  nota: z.string().trim().max(300).optional().nullable(),
  salioDeBilletera: z.boolean().default(true),
})

const updateSchema = z.object({
  persona: z.string().trim().min(1).max(80).optional(),
  telefono: z.string().trim().max(20).nullable().optional(),
  fechaCompromiso: fecha.nullable().optional(),
  nota: z.string().trim().max(300).nullable().optional(),
}).strict()

const abonoSchema = z.object({
  monto: z.number().min(1),
  entraABilletera: z.boolean().default(true),
  nota: z.string().trim().max(200).optional().nullable(),
})

const ampliarSchema = z.object({
  monto: z.number().min(1),
  salioDeBilletera: z.boolean().default(true),
  nota: z.string().trim().max(200).optional().nullable(),
})

const aFecha = (s: string) => new Date(`${s}T12:00:00`)

function serializar(l: ExternalLoan & { payments?: ExternalLoanPayment[] }) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const compromiso = l.fechaCompromiso ? new Date(l.fechaCompromiso) : null
  const diasParaCompromiso = compromiso
    ? Math.round((new Date(compromiso.getUTCFullYear(), compromiso.getUTCMonth(), compromiso.getUTCDate()).getTime() - hoy.getTime()) / 86_400_000)
    : null
  const montoPrestado = Number(l.montoPrestado)
  const saldo = Number(l.saldoPendiente)
  return {
    ...l,
    montoPrestado,
    saldoPendiente: saldo,
    montoDesdeBilletera: Number(l.montoDesdeBilletera),
    montoRecuperado: Math.round((montoPrestado - saldo) * 100) / 100,
    diasParaCompromiso,
    vencido: l.estado === 'activo' && diasParaCompromiso !== null && diasParaCompromiso < 0,
    payments: (l.payments ?? [])
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(p => ({ ...p, monto: Number(p.monto) })),
  }
}

async function cargar(userId: string, id: string) {
  return prisma.externalLoan.findFirst({ where: { id, userId }, include: { payments: true } })
}

async function saldosBilletera(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { cashBalance: true, walletLibre: true, walletEndeudamiento: true, walletAhorro: true, walletObligaciones: true },
  })
  const bolsillos = {
    libre: Number(u?.walletLibre ?? 0),
    endeudamiento: Number(u?.walletEndeudamiento ?? 0),
    ahorro: Number(u?.walletAhorro ?? 0),
    obligaciones: Number(u?.walletObligaciones ?? 0),
  }
  return {
    total: Number(u?.cashBalance ?? 0),
    // Mismo "Gasto libre" que muestra Billetera: libre + capacidad de endeudamiento.
    gastoLibre: Math.max(0, bolsillos.libre) + Math.max(0, bolsillos.endeudamiento),
    bolsillos,
  }
}

async function saldoBilletera(userId: string): Promise<number> {
  return (await saldosBilletera(userId)).total
}

/** Lo que se puede prestar: primero el gasto libre; si no alcanza, el resto del disponible. */
async function disponibleParaPrestar(userId: string) {
  const s = await saldosBilletera(userId)
  return { gastoLibre: s.gastoLibre, total: Math.max(0, s.total) }
}

// ─── GET /external-loans ──────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const loans = await prisma.externalLoan.findMany({
      where: { userId },
      include: { payments: true },
      orderBy: [{ estado: 'asc' }, { fechaCompromiso: 'asc' }, { createdAt: 'desc' }],
    })
    const out = loans.map(serializar)
    const activos = out.filter(l => l.estado === 'activo')
    res.json({
      loans: out,
      disponible: await disponibleParaPrestar(userId),
      resumen: {
        porCobrar: Math.round(activos.reduce((s, l) => s + l.saldoPendiente, 0) * 100) / 100,
        personas: new Set(activos.map(l => l.persona.toLowerCase())).size,
        vencidos: activos.filter(l => l.vencido).length,
        recuperadoTotal: Math.round(out.reduce((s, l) => s + l.montoRecuperado, 0) * 100) / 100,
        perdonadoTotal: Math.round(out.filter(l => l.estado === 'perdonado').reduce((s, l) => s + l.saldoPendiente, 0) * 100) / 100,
      },
    })
  } catch (error) {
    console.error('[GetExternalLoans]', error)
    res.status(500).json({ error: 'Error al obtener los préstamos' })
  }
})

// ─── POST /external-loans — Registrar un préstamo ─────────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const body = req.body as z.infer<typeof createSchema>

    const saldos = await saldosBilletera(userId)
    if (body.salioDeBilletera && saldos.total < body.monto) {
      res.status(400).json({ error: 'No tienes saldo suficiente en tu billetera para este préstamo', code: 'SALDO_INSUFICIENTE', disponible: Math.max(0, saldos.total), requerido: body.monto })
      return
    }

    const crear = prisma.externalLoan.create({
      data: {
        userId,
        persona: body.persona,
        telefono: body.telefono || null,
        montoPrestado: body.monto,
        saldoPendiente: body.monto,
        montoDesdeBilletera: body.salioDeBilletera ? body.monto : 0,
        fechaPrestamo: body.fechaPrestamo ? aFecha(body.fechaPrestamo) : new Date(),
        fechaCompromiso: body.fechaCompromiso ? aFecha(body.fechaCompromiso) : null,
        nota: body.nota || null,
      },
      include: { payments: true },
    })
    const [loan] = body.salioDeBilletera
      ? await prisma.$transaction([crear, prisma.user.update({ where: { id: userId }, data: planDeduccionEnCascada(saldos.bolsillos, body.monto).data })])
      : [await crear]

    res.status(201).json({ loan: serializar(loan) })
  } catch (error) {
    console.error('[CreateExternalLoan]', error)
    res.status(500).json({ error: 'Error al registrar el préstamo' })
  }
})

// ─── PATCH /external-loans/:id — Datos de contacto, fecha prometida, nota ─────

router.patch('/:id', validate(updateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing) {
      res.status(404).json({ error: 'Préstamo no encontrado' })
      return
    }
    const body = req.body as z.infer<typeof updateSchema>
    const data: Prisma.ExternalLoanUpdateInput = {}
    if (body.persona !== undefined) data.persona = body.persona
    if (body.telefono !== undefined) data.telefono = body.telefono || null
    if (body.nota !== undefined) data.nota = body.nota || null
    if (body.fechaCompromiso !== undefined) data.fechaCompromiso = body.fechaCompromiso ? aFecha(body.fechaCompromiso) : null
    const loan = await prisma.externalLoan.update({ where: { id: existing.id }, data, include: { payments: true } })
    res.json({ loan: serializar(loan) })
  } catch (error) {
    console.error('[UpdateExternalLoan]', error)
    res.status(500).json({ error: 'Error al actualizar el préstamo' })
  }
})

// ─── POST /external-loans/:id/abono — La persona devolvió plata ───────────────

router.post('/:id/abono', validate(abonoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing || existing.estado !== 'activo') {
      res.status(404).json({ error: 'Préstamo activo no encontrado' })
      return
    }
    const body = req.body as z.infer<typeof abonoSchema>
    const saldo = Number(existing.saldoPendiente)
    if (body.monto > saldo + 0.009) {
      res.status(400).json({ error: `El abono supera lo que te deben (${saldo})` })
      return
    }
    const nuevoSaldo = Math.max(0, Math.round((saldo - body.monto) * 100) / 100)
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.externalLoanPayment.create({ data: { loanId: existing.id, monto: body.monto, entraABilletera: body.entraABilletera, nota: body.nota || null } }),
      prisma.externalLoan.update({
        where: { id: existing.id },
        data: { saldoPendiente: nuevoSaldo, ...(nuevoSaldo === 0 ? { estado: 'pagado', cerradoEn: new Date() } : {}) },
      }),
    ]
    if (body.entraABilletera) ops.push(prisma.user.update({ where: { id: userId }, data: planPocketCredit('libre', body.monto) }))
    await prisma.$transaction(ops)

    res.json({ loan: serializar((await cargar(userId, existing.id))!), saldado: nuevoSaldo === 0 })
  } catch (error) {
    console.error('[AbonoExternalLoan]', error)
    res.status(500).json({ error: 'Error al registrar el abono' })
  }
})

// ─── DELETE /external-loans/:id/abono/:paymentId — Deshacer un abono ─────────

router.delete('/:id/abono/:paymentId', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    const payment = existing?.payments.find(p => p.id === req.params.paymentId)
    if (!existing || !payment) {
      res.status(404).json({ error: 'Abono no encontrado' })
      return
    }
    const monto = Number(payment.monto)
    if (payment.entraABilletera && (await saldoBilletera(userId)) < monto) {
      res.status(400).json({ error: 'Ese abono ya no está en tu billetera; no se puede deshacer sin dejarla en negativo' })
      return
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.externalLoanPayment.delete({ where: { id: payment.id } }),
      prisma.externalLoan.update({
        where: { id: existing.id },
        data: {
          saldoPendiente: { increment: monto },
          // Deshacer un abono reabre el préstamo si ese abono lo había saldado.
          ...(existing.estado === 'pagado' ? { estado: 'activo', cerradoEn: null } : {}),
        },
      }),
    ]
    if (payment.entraABilletera) ops.push(prisma.user.update({ where: { id: userId }, data: planPocketDeduction('libre', monto) }))
    await prisma.$transaction(ops)
    res.json({ loan: serializar((await cargar(userId, existing.id))!) })
  } catch (error) {
    console.error('[UndoAbonoExternalLoan]', error)
    res.status(500).json({ error: 'Error al deshacer el abono' })
  }
})

// ─── POST /external-loans/:id/ampliar — Le presté más a la misma persona ─────

router.post('/:id/ampliar', validate(ampliarSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing || existing.estado === 'perdonado') {
      res.status(404).json({ error: 'Préstamo no encontrado' })
      return
    }
    const body = req.body as z.infer<typeof ampliarSchema>
    const saldos = await saldosBilletera(userId)
    if (body.salioDeBilletera && saldos.total < body.monto) {
      res.status(400).json({ error: 'No tienes saldo suficiente en tu billetera', code: 'SALDO_INSUFICIENTE', disponible: Math.max(0, saldos.total), requerido: body.monto })
      return
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.externalLoan.update({
        where: { id: existing.id },
        data: {
          montoPrestado: { increment: body.monto },
          saldoPendiente: { increment: body.monto },
          montoDesdeBilletera: { increment: body.salioDeBilletera ? body.monto : 0 },
          estado: 'activo',
          cerradoEn: null,
          ...(body.nota ? { nota: existing.nota ? `${existing.nota}\n${body.nota}` : body.nota } : {}),
        },
      }),
    ]
    if (body.salioDeBilletera) ops.push(prisma.user.update({ where: { id: userId }, data: planDeduccionEnCascada(saldos.bolsillos, body.monto).data }))
    await prisma.$transaction(ops)
    res.json({ loan: serializar((await cargar(userId, existing.id))!) })
  } catch (error) {
    console.error('[AmpliarExternalLoan]', error)
    res.status(500).json({ error: 'Error al ampliar el préstamo' })
  }
})

// ─── POST /external-loans/:id/perdonar — Dar por perdida la plata ────────────
// No mueve la billetera (la plata ya había salido); queda registrado como
// perdonado con el saldo que no se recuperó, y deja de contar "por cobrar".

router.post('/:id/perdonar', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing || existing.estado !== 'activo') {
      res.status(404).json({ error: 'Préstamo activo no encontrado' })
      return
    }
    const loan = await prisma.externalLoan.update({
      where: { id: existing.id },
      data: { estado: 'perdonado', cerradoEn: new Date() },
      include: { payments: true },
    })
    res.json({ loan: serializar(loan) })
  } catch (error) {
    console.error('[PerdonarExternalLoan]', error)
    res.status(500).json({ error: 'Error al actualizar el préstamo' })
  }
})

// ─── POST /external-loans/:id/reabrir — Deshacer "perdonar" ──────────────────

router.post('/:id/reabrir', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing || existing.estado !== 'perdonado') {
      res.status(404).json({ error: 'Préstamo perdonado no encontrado' })
      return
    }
    const loan = await prisma.externalLoan.update({
      where: { id: existing.id },
      data: { estado: 'activo', cerradoEn: null },
      include: { payments: true },
    })
    res.json({ loan: serializar(loan) })
  } catch (error) {
    console.error('[ReabrirExternalLoan]', error)
    res.status(500).json({ error: 'Error al reabrir el préstamo' })
  }
})

// ─── DELETE /external-loans/:id — Borrar el registro como si no hubiera pasado ─
// Revierte su efecto en la billetera: devuelve lo que salió de ella y quita lo
// que entró por abonos.

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const existing = await cargar(userId, req.params.id as string)
    if (!existing) {
      res.status(404).json({ error: 'Préstamo no encontrado' })
      return
    }
    const entradoPorAbonos = existing.payments.filter(p => p.entraABilletera).reduce((s, p) => s + Number(p.monto), 0)
    const ajuste = Math.round((Number(existing.montoDesdeBilletera) - entradoPorAbonos) * 100) / 100
    if (ajuste < 0 && (await saldoBilletera(userId)) < -ajuste) {
      res.status(400).json({ error: 'Borrarlo dejaría tu billetera en negativo (los abonos que recibiste ya no están)' })
      return
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [prisma.externalLoan.delete({ where: { id: existing.id } })]
    if (ajuste > 0) ops.push(prisma.user.update({ where: { id: userId }, data: planPocketCredit('libre', ajuste) }))
    if (ajuste < 0) ops.push(prisma.user.update({ where: { id: userId }, data: planPocketDeduction('libre', -ajuste) }))
    await prisma.$transaction(ops)
    res.json({ message: 'Préstamo eliminado', ajusteBilletera: ajuste })
  } catch (error) {
    console.error('[DeleteExternalLoan]', error)
    res.status(500).json({ error: 'Error al eliminar el préstamo' })
  }
})

export default router
