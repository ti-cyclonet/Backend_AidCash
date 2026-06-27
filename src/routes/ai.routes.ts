import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// ─── POST /ai/coach ───────────────────────────────────────────────────────────
// Placeholder — conectar con Genkit/Google AI cuando se configure

router.post('/coach', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body

    // TODO: Integrar con Genkit proactive-coach-flow
    // Por ahora responde con un mensaje placeholder
    res.json({
      respuesta: 'El coach de IA está en proceso de integración. Pronto recibirás consejos personalizados basados en tu actividad financiera.',
      patronDetectado: null,
      accionSugerida: null,
      impactoEstimado: null,
    })
  } catch (error) {
    console.error('[AI Coach]', error)
    res.status(500).json({
      respuesta: 'No pude conectar con el coach ahora mismo.',
      patronDetectado: null,
      accionSugerida: null,
      impactoEstimado: null,
    })
  }
})

// ─── POST /ai/budget-insight ──────────────────────────────────────────────────

router.post('/budget-insight', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body

    // TODO: Integrar con Genkit budget-adjustment-explanation-flow
    res.json({
      explicacion: `Tu distribución actual destina un ${body.pctObligacionesAjustado ?? 0}% a obligaciones. ` +
        `Se reserva ${body.pctAhorroAjustado ?? 0}% para ahorro y ${body.pctLibreAjustado ?? 0}% para libre inversión. ` +
        'El coach de IA se está integrando para darte análisis más detallados.',
    })
  } catch (error) {
    console.error('[AI budget-insight]', error)
    res.status(500).json({
      error: 'No se pudo generar el análisis. Intenta de nuevo.',
    })
  }
})

// ─── POST /ai/scan-receipt ────────────────────────────────────────────────────

router.post('/scan-receipt', async (req: Request, res: Response): Promise<void> => {
  try {
    const { imageBase64, mimeType } = req.body

    if (!imageBase64 || !mimeType) {
      res.status(400).json({ error: 'Se requiere imageBase64 y mimeType' })
      return
    }

    // TODO: Integrar con Genkit receipt-scanner-flow
    res.json({
      items: [],
      total: 0,
      categoria: 'otro',
      mensaje: 'El escáner de recibos está en proceso de integración.',
    })
  } catch (error) {
    console.error('[AI Receipt Scanner]', error)
    res.status(500).json({
      error: 'No se pudo procesar el recibo.',
    })
  }
})

export default router
