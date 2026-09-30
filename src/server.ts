import http from 'http'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { env } from './config/env.js'
import { connectDatabase } from './config/database.js'
import { errorHandler } from './middleware/error-handler.js'
import { initSocket } from './lib/socket.js'
import { initPaymentNotificationsCron } from './cron/payment-notifications.js'
import { initBelvoSyncCron } from './cron/belvo-sync.js'
import { initSpendingProjectionsCron } from './cron/spending-projections.js'
import { initObligationDueDatesCron } from './cron/obligation-due-dates.js'
import { initAutoPayCron } from './cron/auto-pay.js'
import { initExternalLoansCron } from './cron/external-loans.js'

// Routes
import authRoutes from './routes/auth.routes.js'
import userRoutes from './routes/user.routes.js'
import debtsRoutes from './routes/debts.routes.js'
import fixedExpensesRoutes from './routes/fixed-expenses.routes.js'
import savingsRoutes from './routes/savings.routes.js'
import extraIncomesRoutes from './routes/extra-incomes.routes.js'
import impulseRoutes from './routes/impulse.routes.js'
import emergencyFundRoutes from './routes/emergency-fund.routes.js'
import gamificationRoutes from './routes/gamification.routes.js'
import missionsRoutes from './routes/missions.routes.js'
import reportsRoutes from './routes/reports.routes.js'
import connectionsRoutes from './routes/connections.routes.js'
import sharedPocketsRoutes from './routes/shared-pockets.routes.js'
import loansRoutes from './routes/loans.routes.js'
import externalLoansRoutes from './routes/external-loans.routes.js'
import inviteLinksRoutes from './routes/invite-links.routes.js'
import hogarRoutes from './routes/hogar.routes.js'
import aiRoutes from './routes/ai.routes.js'
import { initMissionRemindersCron } from './cron/mission-reminders.js'
import homeBudgetRoutes from './routes/home-budget.routes.js'
import expenseSplitRoutes from './routes/expense-split.routes.js'
import banksRoutes from './routes/banks.routes.js'
import usageStatusRoutes from './routes/usage-status.routes.js'
import planRoutes from './routes/plan.routes.js'
import savingsPocketsRoutes from './routes/savings-pockets.routes.js'
import budgetCategoriesRoutes from './routes/budget-categories.routes.js'
import openBankingRoutes from './routes/open-banking.routes.js'
import projectionsRoutes from './routes/projections.routes.js'
import supportRoutes from './routes/support.routes.js'
import notificationsRoutes from './routes/notifications.routes.js'
import { traducirRespuestas } from './lib/i18n.js'

const app = express()
const httpServer = http.createServer(app)

// ─── Middleware global ────────────────────────────────────────────────────────

// Trust first proxy (Nginx reverse proxy on EC2)
app.set('trust proxy', 1)

app.use(helmet())

// CORS: soporta múltiples orígenes separados por coma en FRONTEND_URL
const allowedOrigins = env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean)
// Always allow the landing page origins for cross-origin plan upgrade requests
const landingOrigins = ['https://www.cyclonet.com.co', 'https://cyclonet.com.co', 'http://localhost', 'http://localhost:80']
const allAllowedOrigins = [...new Set([...allowedOrigins, ...landingOrigins])]
app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true)
    if (allAllowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error(`Origin ${origin} not allowed by CORS`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-kiri-idioma'],
}))
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))
// Errores y mensajes de la API en el idioma de la app (x-kiri-idioma: en)
app.use(traducirRespuestas)

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Por IP. Cada pantalla hace ~25 llamadas y en Colombia los operadores
  // móviles comparten una IP entre muchos usuarios (CGNAT): con 1000 un grupo
  // de usuarios activos recibía "Demasiadas solicitudes" sin haber abusado.
  // El login tiene su propio límite estricto (authLimiter).
  max: 5000,
  message: { error: 'Demasiadas solicitudes, intenta más tarde.' },
})
app.use(limiter)

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  // Por IP real (req.ip, con `trust proxy` = el salto de Nginx). Antes se usaba
  // la cabecera x-forwarded-for tal cual: quien la cambiara en cada intento
  // tenía intentos de login ilimitados.
  keyGenerator: (req) => req.ip || 'unknown',
  message: { error: 'Demasiados intentos, espera 15 minutos.' },
})

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/debts', debtsRoutes)
app.use('/api/fixed-expenses', fixedExpensesRoutes)
app.use('/api/savings', savingsRoutes)
app.use('/api/extra-incomes', extraIncomesRoutes)
app.use('/api/impulse-expenses', impulseRoutes)
app.use('/api/emergency-fund', emergencyFundRoutes)
app.use('/api/gamification', gamificationRoutes)
app.use('/api/missions', missionsRoutes)
app.use('/api/reports', reportsRoutes)
app.use('/api/connections', connectionsRoutes)
app.use('/api/shared-pockets', sharedPocketsRoutes)
app.use('/api/loans', loansRoutes)
app.use('/api/external-loans', externalLoansRoutes)
app.use('/api/invite-links', inviteLinksRoutes)
app.use('/api/hogar', hogarRoutes)
app.use('/api/ai', aiRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/home-budget', homeBudgetRoutes)
app.use('/api/expenses/split', expenseSplitRoutes)
app.use('/api/banks', banksRoutes)
app.use('/api/usage-status', usageStatusRoutes)
app.use('/api/plan', planRoutes)
app.use('/api/savings-pockets', savingsPocketsRoutes)
app.use('/api/budget-categories', budgetCategoriesRoutes)
app.use('/api/open-banking', openBankingRoutes)
app.use('/api/projections', projectionsRoutes)
app.use('/api/support', supportRoutes)

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use(errorHandler)

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  await connectDatabase()

  // Inicializar Socket.io sobre el servidor HTTP
  initSocket(httpServer)

  // Inicializar cron jobs
  initPaymentNotificationsCron()
  initBelvoSyncCron()
  initSpendingProjectionsCron()
  initObligationDueDatesCron()
  initAutoPayCron()
  initExternalLoansCron()
  initMissionRemindersCron()

  // backlog 2048: cola de conexiones por aceptar. Con el valor por defecto, en
  // la prueba de carga (100 usuarios abriendo el Dashboard a la vez) el sistema
  // rechazaba conexiones (ECONNREFUSED) en ráfagas. En Linux el tope real es
  // net.core.somaxconn.
  httpServer.listen({ port: Number(env.PORT), backlog: 2048 }, () => {
    console.log(`
🌱 Kiri Finance Backend
━━━━━━━━━━━━━━━━━━━━━━━━━
  Puerto:      ${env.PORT}
  Entorno:     ${env.NODE_ENV}
  Frontend:    ${env.FRONTEND_URL}
  Health:      http://localhost:${env.PORT}/api/health
  Socket.io:   ✅ activo
━━━━━━━━━━━━━━━━━━━━━━━━━
    `)
  })
}

bootstrap().catch(console.error)

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

import { closeSocket } from './lib/socket.js'

function gracefulShutdown(signal: string) {
  console.log(`\n[${signal}] Cerrando servidor...`)
  closeSocket()
  httpServer.close(() => {
    console.log('✅ Servidor cerrado limpiamente')
    process.exit(0)
  })
  // Forzar cierre si tarda más de 5s
  setTimeout(() => process.exit(1), 5000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

export default app
