/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Correo saliente (SMTP)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Mismo patrón que `push.ts` para VAPID: si no hay credenciales SMTP en el
 * entorno, `sendMail` no-opea (devuelve `false` con un warning) en vez de
 * romper la ruta que lo llama. Configura SMTP_HOST/PORT/USER/PASS en el .env
 * del backend para que el envío real funcione.
 */

import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../config/env.js'

let transporter: Transporter | null = null

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
    console.log('[Mail] SMTP configurado ✅')
  }
  return transporter
}

if (!getTransporter()) {
  console.warn('[Mail] SMTP_HOST/SMTP_USER/SMTP_PASS no configuradas. Envío de correo deshabilitado.')
}

export interface MailAttachment {
  filename: string
  /** Contenido en base64 (con o sin el prefijo "data:...;base64,") */
  contentBase64: string
}

export interface SendMailInput {
  to: string
  subject: string
  html: string
  replyTo?: string
  attachments?: MailAttachment[]
}

/** Envía un correo. Devuelve `false` (sin lanzar) si SMTP no está configurado
 * o si el envío falla — quien llama decide cómo responder al usuario. */
export async function sendMail(input: SendMailInput): Promise<boolean> {
  const t = getTransporter()
  if (!t) return false

  try {
    await t.sendMail({
      from: env.SMTP_FROM,
      to: input.to,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      attachments: input.attachments?.map(a => ({
        filename: a.filename,
        content: a.contentBase64.replace(/^data:[^;]+;base64,/, ''),
        encoding: 'base64' as const,
      })),
    })
    return true
  } catch (error) {
    console.error('[Mail] Error al enviar correo:', error)
    return false
  }
}
