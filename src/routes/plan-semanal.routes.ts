import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { planSemanal, estadoPlanParaArbol, semanasEnRango } from '../lib/plan-semanal.js'

const router = Router()
router.use(authMiddleware)

/**
 * GET /plan-semanal?obligaciones=N — Plan de gasto por semanas hasta el próximo
 * cobro (ver lib/plan-semanal.ts). `obligaciones` es lo pendiente del periodo
 * que ya muestra Billetera; de paso cierra las semanas terminadas.
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const obligaciones = Number(req.query.obligaciones ?? 0)
    const plan = await planSemanal(req.user!.userId, Number.isFinite(obligaciones) ? obligaciones : 0)
    if (!plan) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    res.json(plan)
  } catch (error) {
    console.error('[PlanSemanal]', error)
    res.status(500).json({ error: 'No se pudo calcular tu plan semanal' })
  }
})

/**
 * GET /plan-semanal/semanas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — semanas del plan
 * que empiezan en ese rango (para el Historial: meta, gastado y sello).
 */
router.get('/semanas', async (req: Request, res: Response): Promise<void> => {
  try {
    const fecha = (v: unknown) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''))
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
    }
    const desde = fecha(req.query.desde), hasta = fecha(req.query.hasta)
    if (!desde || !hasta || hasta < desde || hasta.getTime() - desde.getTime() > 400 * 86_400_000) {
      res.status(400).json({ error: 'Rango inválido' }); return
    }
    res.json({ semanas: await semanasEnRango(req.user!.userId, desde, new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate() + 1)) })
  } catch (error) {
    console.error('[PlanSemanal/semanas]', error)
    res.status(500).json({ error: 'No se pudieron leer tus semanas' })
  }
})

/** GET /plan-semanal/arbol — ritmo de la semana y última semana cerrada, para el Jardín */
router.get('/arbol', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await estadoPlanParaArbol(req.user!.userId))
  } catch (error) {
    console.error('[PlanSemanal/arbol]', error)
    res.status(500).json({ error: 'No se pudo leer tu plan semanal' })
  }
})

export default router
