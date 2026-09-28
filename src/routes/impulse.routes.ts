import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { recordMissionAction } from '../lib/missions.js'
import { getPeriodo } from '../lib/period.js'
import { planPocketCredit, planPocketDeduction } from '../lib/wallet.js'
import { sugerirCategoria, extraerEtiquetaCategoria } from '../lib/categorias.js'
import { alertaTrasGasto } from '../lib/category-summary.js'
import { sendPushToUser } from '../lib/push.js'
import { buildInstallmentRevertOps } from '../lib/installments.js'
import { esGastoHormiga, nombreBaseGasto } from '../lib/hormiga.js'
import type { Prisma } from '@prisma/client'

const router = Router()
router.use(authMiddleware)

/**
 * Un gasto hormiga no tiene frecuencia propia — pertenece al periodo de
 * INGRESO del usuario (mensual o quincenal, con sus días de pago reales), no
 * al de una obligación. Antes se etiquetaba con el mes en español
 * ("agosto de 2026", sin concepto de quincena) y el listado por defecto ni
 * siquiera filtraba por periodo — traía los últimos 50 registros de todo el
 * historial. Ahora usa la misma `getPeriodo()` que deudas y gastos fijos, así
 * "gasto de este periodo" significa lo mismo en toda la app.
 */
async function currentUserPeriodo(userId: string, now: Date = new Date()): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { frecuenciaIngreso: true, diasPago: true } })
  return getPeriodo(user?.frecuenciaIngreso ?? 'mensual', user?.diasPago ?? [], now)
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  monto: z.number().min(0),
  categoria: z.enum(['cafe', 'comida', 'transporte', 'antojo', 'salida', 'otro']).default('otro'),
  // Si se paga con tarjeta de crédito: mismo mecanismo de cuotas que
  // pay-with-card para deudas/gastos fijos (ver debts.routes.ts).
  tarjetaId: z.string().uuid().optional(),
  cuotas: z.number().int().min(1).max(48).optional(),
  // Si no viene, se clasifica solo (ver lib/hormiga.ts).
  esHormiga: z.boolean().optional(),
  // Categoría de presupuesto: omitida = Kiri la sugiere (historial del
  // usuario o palabras clave); null explícito = "sin categoría".
  budgetCategoryId: z.string().uuid().nullable().optional(),
  // Clientes nuevos piden que el descuento de la billetera ocurra ACÁ, en la
  // misma transacción que el gasto — antes el frontend lo hacía en una
  // segunda llamada y, si fallaba, quedaba el gasto sin descontar. Los
  // clientes viejos (PWA en caché) no lo mandan y siguen descontando ellos.
  descontarBilletera: z.boolean().optional(),
})

const updateSchema = z.object({
  esHormiga: z.boolean().optional(),
  categoria: z.enum(['cafe', 'comida', 'transporte', 'antojo', 'salida', 'otro']).optional(),
  budgetCategoryId: z.string().uuid().nullable().optional(),
}).strict()

async function categoriaDelUsuario(userId: string, id: string | null | undefined): Promise<boolean> {
  if (!id) return true
  return !!(await prisma.budgetCategory.findFirst({ where: { id, userId }, select: { id: true } }))
}

// ─── GET /impulse-expenses ────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const limit = parseInt(req.query.limit as string) || 50
    const currentPeriodo = await currentUserPeriodo(userId)
    // Sin `periodo` explícito en query → periodo ACTUAL del usuario, no
    // "los últimos 50 registros de todo el historial" (así se comportaba antes).
    const periodo = (req.query.periodo as string | undefined) ?? currentPeriodo

    const expenses = await prisma.impulseExpense.findMany({
      where: { userId, periodo },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Total del periodo actual
    const totalResult = await prisma.impulseExpense.aggregate({
      where: { userId, periodo: currentPeriodo },
      _sum: { monto: true },
    })

    res.json({
      expenses,
      totalThisPeriod: Number(totalResult._sum.monto ?? 0),
      currentPeriodo,
    })
  } catch (error) {
    console.error('[GetImpulse]', error)
    res.status(500).json({ error: 'Error al obtener gastos hormiga' })
  }
})

// ─── GET /impulse-expenses/top-consumos ───────────────────────────────────────
// Agrupa gastos por nombre, suma montos, ordena desc. Soporta filtro por categoría.
// `alcance=mes` mira el mes calendario completo en vez del periodo de ingreso
// (para un usuario quincenal, el periodo es solo media quincena de gastos).
// IMPORTANTE: Esta ruta DEBE estar antes de /:id para que Express no la confunda.

router.get('/top-consumos', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const categoria = req.query.categoria as string | undefined
    const limit = parseInt(req.query.limit as string) || 10
    const periodo = (req.query.periodo as string | undefined) ?? await currentUserPeriodo(userId)
    const alcanceMes = req.query.alcance === 'mes'

    const now = new Date()
    const where: Prisma.ImpulseExpenseWhereInput = alcanceMes
      ? { userId, createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1), lt: new Date(now.getFullYear(), now.getMonth() + 1, 1) } }
      : { userId, periodo }
    if (categoria) where.categoria = categoria
    if (req.query.soloHormiga === 'true') where.esHormiga = true

    // Se agrupa en memoria por nombre NORMALIZADO, no con groupBy de Prisma
    // por el nombre crudo: el mismo consumo se guardaba con variantes
    // ("InDriver", "InDriver [Transporte]", "🐜 indriver") y cada una salía
    // como un ítem aparte — el top mostraba $50.000 en InDriver cuando la
    // suma real de todas sus variantes era mucho mayor.
    const expenses = await prisma.impulseExpense.findMany({ where, select: { nombre: true, monto: true } })
    const totalGastado = expenses.reduce((s, e) => s + Number(e.monto), 0)

    const grupos = new Map<string, { nombre: string; totalGastado: number; cantidad: number }>()
    for (const e of expenses) {
      const nombre = nombreBaseGasto(e.nombre) || e.nombre
      const key = nombre.toLowerCase()
      const g = grupos.get(key) ?? { nombre, totalGastado: 0, cantidad: 0 }
      g.totalGastado = Math.round((g.totalGastado + Number(e.monto)) * 100) / 100
      g.cantidad++
      grupos.set(key, g)
    }

    const items = [...grupos.values()]
      .sort((a, b) => b.totalGastado - a.totalGastado)
      .slice(0, limit)
      .map(g => ({
        ...g,
        porcentaje: totalGastado > 0 ? Math.round((g.totalGastado / totalGastado) * 1000) / 10 : 0,
      }))

    res.json({
      items,
      totalGastado,
      periodo,
      alcance: alcanceMes ? 'mes' : 'periodo',
    })
  } catch (error) {
    console.error('[TopConsumos]', error)
    res.status(500).json({ error: 'Error al obtener top consumos' })
  }
})

// ─── POST /impulse-expenses ───────────────────────────────────────────────────

router.post('/', validate(createSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, categoria, tarjetaId, cuotas, descontarBilletera } = req.body
    let nombre: string = req.body.nombre
    const esHormiga: boolean = req.body.esHormiga ?? esGastoHormiga(nombreBaseGasto(nombre), monto)

    // Categoría: explícita → etiqueta legacy en el nombre → sugerencia de Kiri.
    let budgetCategoryId: string | null | undefined = req.body.budgetCategoryId
    let categoriaAutomatica: string | null = null
    if (budgetCategoryId === undefined) {
      const etiqueta = await extraerEtiquetaCategoria(userId, nombre)
      if (etiqueta.categoryId) {
        nombre = etiqueta.nombre
        budgetCategoryId = etiqueta.categoryId
      } else {
        const sugerencia = await sugerirCategoria(userId, nombre)
        budgetCategoryId = sugerencia?.categoryId ?? null
        categoriaAutomatica = sugerencia?.fuente ?? null
      }
    } else if (!(await categoriaDelUsuario(userId, budgetCategoryId))) {
      res.status(400).json({ error: 'Categoría no válida' })
      return
    }

    const periodo = await currentUserPeriodo(userId)

    let expense
    if (tarjetaId) {
      const tarjeta = await prisma.debt.findFirst({ where: { id: tarjetaId, userId, estado: 'activa' } })
      if (!tarjeta) {
        res.status(404).json({ error: 'Tarjeta de crédito no encontrada' })
        return
      }
      const numCuotas = cuotas ?? 1
      const incrementoCuota = Math.round((monto / numCuotas) * 100) / 100
      // Mismo orden que /debts/pay-with-card: el plan de cuotas se crea
      // primero (con id pre-generado) para que el gasto pueda referenciarlo
      // por FK dentro de la misma transacción.
      const installmentId = randomUUID()
      const [, createdExpense] = await prisma.$transaction([
        prisma.debtCardInstallment.create({
          data: { id: installmentId, tarjetaId, cuotaMensual: incrementoCuota, cuotasTotal: numCuotas, descripcion: nombre },
        }),
        prisma.impulseExpense.create({
          data: { userId, nombre, monto, categoria, periodo, esHormiga, budgetCategoryId, tarjetaId, installmentId },
        }),
        prisma.debt.update({
          where: { id: tarjetaId },
          data: { saldoRestante: { increment: monto }, saldoPrincipal: { increment: monto } },
        }),
      ])
      expense = createdExpense
    } else {
      const crear = prisma.impulseExpense.create({
        data: { userId, nombre, monto, categoria, periodo, esHormiga, budgetCategoryId },
      })
      expense = descontarBilletera
        ? (await prisma.$transaction([crear, prisma.user.update({ where: { id: userId }, data: planPocketDeduction('libre', monto) })]))[0]
        : await crear
    }

    await recordMissionAction(userId, 'gasto_hormiga')

    // ¿Este gasto hizo cruzar el 80% o el 100% del límite de su categoría?
    const alertaCategoria = budgetCategoryId ? await alertaTrasGasto(userId, budgetCategoryId, monto) : null
    if (alertaCategoria) {
      sendPushToUser(userId, {
        title: alertaCategoria.nivel === 'excedido' ? `🚨 Te pasaste en ${alertaCategoria.categoria}` : `⚠️ Vas en el ${alertaCategoria.porcentaje}% de ${alertaCategoria.categoria}`,
        body: `Llevas $${Math.round(alertaCategoria.gastado).toLocaleString('es-CO')} de $${Math.round(alertaCategoria.limite).toLocaleString('es-CO')} en este periodo.`,
        tag: `categoria-${alertaCategoria.categoryId}`,
        url: '/gestion',
      }).catch(() => {})
    }

    res.status(201).json({ expense, categoriaAutomatica, alertaCategoria, billeteraDescontada: !!descontarBilletera && !tarjetaId })
  } catch (error) {
    console.error('[CreateImpulse]', error)
    res.status(500).json({ error: 'Error al registrar gasto hormiga' })
  }
})

// ─── PATCH /impulse-expenses/:id ──────────────────────────────────────────────
// Corregir la clasificación automática (hormiga sí/no) o la categoría. El
// monto no se edita acá: ya se descontó de la billetera o de una tarjeta al
// crearlo — para cambiarlo se elimina (que revierte todo) y se registra de nuevo.

router.patch('/:id', validate(updateSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.impulseExpense.findFirst({ where: { id, userId } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto no encontrado' })
      return
    }

    if (!(await categoriaDelUsuario(userId, req.body.budgetCategoryId))) {
      res.status(400).json({ error: 'Categoría no válida' })
      return
    }

    const expense = await prisma.impulseExpense.update({ where: { id }, data: req.body })
    res.json({ expense })
  } catch (error) {
    console.error('[UpdateImpulse]', error)
    res.status(500).json({ error: 'Error al actualizar el gasto' })
  }
})

// ─── DELETE /impulse-expenses/:id ─────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const existing = await prisma.impulseExpense.findFirst({ where: { id, userId }, include: { tarjeta: { select: { nombre: true } } } })
    if (!existing) {
      res.status(404).json({ error: 'Gasto hormiga no encontrado' })
      return
    }

    // Si el gasto se dividió con amigos (Social), ya generó préstamos a su
    // nombre: borrarlo acá dejaría esas deudas apuntando a un gasto que no
    // existe. Primero hay que resolver/cancelar esos préstamos.
    const prestamosVivos = await prisma.loan.count({ where: { sourceExpenseId: id, status: { notIn: ['REJECTED', 'PAID'] } } })
    if (prestamosVivos > 0) {
      res.status(409).json({ error: 'Este gasto está dividido con amigos en Social. Cancela o termina esos préstamos antes de eliminarlo.' })
      return
    }

    // Revertir el gasto por completo, no solo borrar la fila — antes esto
    // dejaba el saldo de la tarjeta (o el bolsillo "libre") desincronizado
    // para siempre, sin ninguna forma de volver al estado previo.
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.impulseExpense.delete({ where: { id } }),
    ]

    if (existing.tarjetaId && existing.installmentId) {
      // Se pagó con tarjeta: revertir el plan de cuotas que generó. Si ya se
      // le habían hecho abonos reales a ESE plan (pagando la cuota de la
      // tarjeta después de la compra), buildInstallmentRevertOps le devuelve
      // esa plata a la billetera en vez de restarla dos veces del saldo —
      // antes esto siempre restaba el monto ORIGINAL completo sin mirar si
      // ya se había abonado algo, lo que dejaba el saldo de la tarjeta mal
      // calculado en ese caso.
      ops.push(...(await buildInstallmentRevertOps(userId, [existing.installmentId])))
    } else {
      // Se pagó en efectivo del bolsillo "libre" al crearlo (ver POST /,
      // rama sin tarjetaId en el frontend) — devolver ese monto.
      ops.push(prisma.user.update({
        where: { id: userId },
        data: planPocketCredit('libre', Number(existing.monto)),
      }))
    }

    await prisma.$transaction(ops)

    // Qué se revirtió, para que el frontend lo diga tal cual.
    res.json({
      message: 'Gasto eliminado',
      reversion: existing.tarjetaId
        ? { tipo: 'tarjeta', monto: Number(existing.monto), tarjetaNombre: existing.tarjeta?.nombre ?? null }
        : { tipo: 'billetera', monto: Number(existing.monto) },
    })
  } catch (error) {
    console.error('[DeleteImpulse]', error)
    res.status(500).json({ error: 'Error al eliminar gasto hormiga' })
  }
})

export default router
