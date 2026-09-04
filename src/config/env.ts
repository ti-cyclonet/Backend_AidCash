import dotenv from 'dotenv'
dotenv.config()

// Validar variables críticas en producción
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev_secret_change_me') {
    throw new Error('❌ JWT_SECRET no está configurado para producción. Define una clave segura en las variables de entorno.')
  }
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET === 'dev_refresh_secret_change_me') {
    throw new Error('❌ JWT_REFRESH_SECRET no está configurado para producción. Define una clave segura en las variables de entorno.')
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('❌ DATABASE_URL no está configurado para producción.')
  }
  if (!process.env.FRONTEND_URL) {
    throw new Error('❌ FRONTEND_URL no está configurado para producción.')
  }
}

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_change_me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_change_me',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:9002',
  GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY || '',
  DISABLE_CORS: process.env.DISABLE_CORS === 'true',

  // ─── Cyclonet / Authoriza Integration ────────────────────────────────────────
  AUTHORIZA_JWT_SECRET: process.env.AUTHORIZA_JWT_SECRET || 'wSddeEwq2e',
  AUTHORIZA_API_URL: process.env.AUTHORIZA_API_URL || 'http://localhost:3000',

  // ─── Belvo Open Banking ─────────────────────────────────────────────────────
  BELVO_SECRET_ID: process.env.BELVO_SECRET_ID || '',
  BELVO_SECRET_PASSWORD: process.env.BELVO_SECRET_PASSWORD || '',
  BELVO_ENV: process.env.BELVO_ENV || 'sandbox', // sandbox | production

  // ─── Correo saliente (SMTP) — usado por /support. Sin configurar, sendMail
  // no-opea con un warning (mismo patrón que VAPID_* para push) ─────────────
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'Kiri Finance <notificaciones@cyclonet.com.co>',
  SUPPORT_EMAIL_TO: process.env.SUPPORT_EMAIL_TO || 'ti.cyclonet@hotmail.com',
} as const
