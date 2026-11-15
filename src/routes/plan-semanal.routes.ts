import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { planSemanal, estadoPlanParaArbol } from '../lib/plan-semanal.js'

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
