import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { sendMail } from '../lib/mail.js'
import { env } from '../config/env.js'

const router = Router()
router.use(authMiddleware)

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSupportSchema = z.object({
  titulo: z.string().min(1, 'El título es requerido').max(150),
  descripcion: z.string().min(1, 'La descripción es requerida').max(5000),
  imagenBase64: z.string().optional(),
})

// ─── POST /support — Enviar un ticket de soporte por correo ──────────────────

router.post('/', validate(createSupportSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { titulo, descripcion, imagenBase64 } = req.body as {
      titulo: string
      descripcion: string
      imagenBase64?: string
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { nombre: true, correo: true },
    })

    const html = `
      <h2>Nuevo ticket de soporte — Kiri Finance</h2>
      <p><strong>De:</strong> ${user?.nombre ?? 'Usuario'} (${user?.correo ?? 'sin correo'})</p>
      <p><strong>Título:</strong> ${titulo}</p>
      <p><strong>Descripción:</strong></p>
      <p>${descripcion.replace(/\n/g, '<br>')}</p>
    `

    const sent = await sendMail({
      to: env.SUPPORT_EMAIL_TO,
      subject: `Soporte Kiri Finance — ${titulo}`,
      html,
      replyTo: user?.correo,
      attachments: imagenBase64 ? [{ filename: 'adjunto.png', contentBase64: imagenBase64 }] : undefined,
    })

    if (!sent) {
      res.status(503).json({ error: 'No se pudo enviar el correo. Intenta más tarde o escríbenos directamente.' })
      return
    }

    res.status(201).json({ message: 'Ticket enviado' })
  } catch (error) {
    console.error('[CreateSupport]', error)
    res.status(500).json({ error: 'Error al enviar el ticket de soporte' })
  }
})

export default router
