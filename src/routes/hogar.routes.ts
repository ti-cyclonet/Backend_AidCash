import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { hogarHabilitado, resolverPlan, otorgarInsigniaPro } from '../lib/planes.js'
import { respuestaFuncion } from '../middleware/limit-enforcement.js'
import type { NextFunction } from 'express'

/** El presupuesto del hogar es de KIRI PRO (basta con que uno de la pareja lo tenga). */
async function requireHogar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await hogarHabilitado(req.user!.userId)) { next(); return }
    res.status(403).json(respuestaFuncion(await resolverPlan(req.user!.userId), 'householdBudget'))
  } catch { next() }
}
import { emitToUser, SOCKET_EVENTS } from '../lib/socket.js'
import { sendPushToUser } from '../lib/push.js'
import { conexionHogar, resumenHogar, categoriaDelUsuario, type PeriodoHogar } from '../lib/hogar.js'

/**
 * Presupuesto del hogar — categorías compartidas en pareja (ver lib/hogar.ts).
 */
const router = Router()
router.use(authMiddleware)

const categoriaSchema = z.object({
  nombre: z.string().trim().min(1).max(40),
  icono: z.string().min(1).max(8).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  montoLimite: z.number().min(0),
}).strict()

const fmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`

// ─── GET /hogar — categorías del mes con lo gastado por cada uno ──────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const [resumen, habilitado] = await Promise.all([resumenHogar(req.user!.userId), hogarHabilitado(req.user!.userId)])
    // habilitado: el hogar es de KIRI PRO (basta con que uno de la pareja lo tenga)
    res.json(resumen ? { conectado: true, habilitado, ...resumen } : { conectado: false, habilitado })
  } catch (error) {
    console.error('[Hogar]', error)
    res.status(500).json({ error: 'Error al cargar el presupuesto del hogar' })
  }
})

// ─── POST /hogar/categorias ───────────────────────────────────────────────────

router.post('/categorias', validate(categoriaSchema), requireHogar, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const hogar = await conexionHogar(userId)
    if (!hogar) { res.status(403).json({ error: 'Conéctate con tu pareja en Social para usar el presupuesto del hogar' }); return }
    const { nombre, icono, color, montoLimite } = req.body as z.infer<typeof categoriaSchema>
    const cat = await prisma.sharedBudgetCategory.create({
      data: { connectionId: hogar.connectionId, nombre, icono: icono ?? '🏠', color: color ?? '#10b981', montoLimite, createdById: userId },
    })
    const titulo = `${cat.icono} ${hogar.yo.nombre.split(' ')[0]} creó "${nombre}" en el hogar`
    const detalle = `Presupuesto de ${fmt(montoLimite)} ${hogar.periodo === 'quincenal' ? 'por quincena' : 'al mes'}. Ya pueden registrar sus gastos ahí.`
    emitToUser(hogar.pareja.id, SOCKET_EVENTS.HOGAR_GASTO, { message: titulo, detalle, route: '/social' })
    sendPushToUser(hogar.pareja.id, { title: titulo, body: detalle, tag: 'hogar-categoria', url: '/social' }).catch(() => {})
    otorgarInsigniaPro(userId, 'pro_hogar_equipo')
    res.status(201).json({ categoria: { ...cat, montoLimite: Number(cat.montoLimite) } })
  } catch (error) {
    console.error('[HogarCrear]', error)
    res.status(500).json({ error: 'Error al crear la categoría' })
  }
})

// ─── PATCH /hogar/periodo — mensual ⇄ quincenal (cualquiera de los dos) ──────
// Por defecto convierte los topes para que el presupuesto siga siendo el
// mismo: $600.000 al mes → $300.000 por quincena (y al revés, ×2).

const periodoSchema = z.object({
  periodo: z.enum(['mensual', 'quincenal']),
  convertirTopes: z.boolean().optional(),
}).strict()

router.patch('/periodo', validate(periodoSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const hogar = await conexionHogar(userId)
    if (!hogar) { res.status(403).json({ error: 'Conéctate con tu pareja en Social para usar el presupuesto del hogar' }); return }
    const { periodo, convertirTopes = true } = req.body as { periodo: PeriodoHogar; convertirTopes?: boolean }
    if (periodo === hogar.periodo) { res.json({ periodo, cambiado: false }); return }

    const factor = periodo === 'quincenal' ? 0.5 : 2
    await prisma.$transaction(async (tx) => {
      await tx.connection.update({ where: { id: hogar.connectionId }, data: { hogarPeriodo: periodo } })
      if (convertirTopes) {
        const cats = await tx.sharedBudgetCategory.findMany({ where: { connectionId: hogar.connectionId } })
        for (const c of cats) {
          await tx.sharedBudgetCategory.update({ where: { id: c.id }, data: { montoLimite: Math.round(Number(c.montoLimite) * factor) } })
        }
      }
    })

    const titulo = `🗓️ ${hogar.yo.nombre.split(' ')[0]} cambió el presupuesto del hogar a ${periodo}`
    const detalle = periodo === 'quincenal'
      ? `Ahora cada tope es por quincena (1–15 y 16–fin de mes)${convertirTopes ? ' y quedó en la mitad' : ''}.`
      : `Ahora cada tope es por mes${convertirTopes ? ' y quedó en el doble' : ''}.`
    emitToUser(hogar.pareja.id, SOCKET_EVENTS.HOGAR_GASTO, { message: titulo, detalle, route: '/social' })
    sendPushToUser(hogar.pareja.id, { title: titulo, body: detalle, tag: 'hogar-periodo', url: '/social' }).catch(() => {})
    res.json({ periodo, cambiado: true })
  } catch (error) {
    console.error('[HogarPeriodo]', error)
    res.status(500).json({ error: 'Error al cambiar el periodo' })
  }
})

// ─── PATCH /hogar/categorias/:id ──────────────────────────────────────────────

router.patch('/categorias/:id', validate(categoriaSchema.partial()), requireHogar, async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await categoriaDelUsuario(req.user!.userId, String(req.params.id))
    if (!r) { res.status(404).json({ error: 'Categoría no encontrada' }); return }
    const cat = await prisma.sharedBudgetCategory.update({ where: { id: r.cat.id }, data: req.body })
    res.json({ categoria: { ...cat, montoLimite: Number(cat.montoLimite) } })
  } catch (error) {
    console.error('[HogarEditar]', error)
    res.status(500).json({ error: 'Error al editar la categoría' })
  }
})

// ─── DELETE /hogar/categorias/:id — los gastos quedan, sin categoría del hogar ─

router.delete('/categorias/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await categoriaDelUsuario(req.user!.userId, String(req.params.id))
    if (!r) { res.status(404).json({ error: 'Categoría no encontrada' }); return }
    await prisma.sharedBudgetCategory.delete({ where: { id: r.cat.id } })
    res.json({ message: 'Categoría eliminada' })
  } catch (error) {
    console.error('[HogarEliminar]', error)
    res.status(500).json({ error: 'Error al eliminar la categoría' })
  }
})

export default router
