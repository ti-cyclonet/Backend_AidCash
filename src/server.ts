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
import aiRoutes from './routes/ai.routes.js'
import reportsRoutes from './routes/reports.routes.js'
import connectionsRoutes from './routes/connections.routes.js'
import sharedPocketsRoutes from './routes/shared-pockets.routes.js'
import loansRoutes from './routes/loans.routes.js'
import homeBudgetRoutes from './routes/home-budget.routes.js'
import expenseSplitRoutes from './routes/expense-split.routes.js'
import banksRoutes from './routes/banks.routes.js'
import usageStatusRoutes from './routes/usage-status.routes.js'
import planRoutes from './routes/plan.routes.js'

const app = express()
const httpServer = http.createServer(app)

// ─── Middleware global ────────────────────────────────────────────────────────

// Trust first proxy (Nginx reverse proxy on EC2)
app.set('trust proxy', 1)

app.use(helmet())

// CORS: soporta múltiples orígenes separados por coma en FRONTEND_URL
const allowedOrigins = env.FRONTEND_URL.split(',').map(o => o.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error(`Origin ${origin} not allowed by CORS`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id'],
}))
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Demasiadas solicitudes, intenta más tarde.' },
})
app.use(limiter)

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.NODE_ENV === 'development' ? 100 : 15,
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
app.use('/api/ai', aiRoutes)
app.use('/api/reports', reportsRoutes)
app.use('/api/connections', connectionsRoutes)
app.use('/api/shared-pockets', sharedPocketsRoutes)
app.use('/api/loans', loansRoutes)
app.use('/api/home-budget', homeBudgetRoutes)
app.use('/api/expenses/split', expenseSplitRoutes)
app.use('/api/banks', banksRoutes)
app.use('/api/usage-status', usageStatusRoutes)
app.use('/api/plan', planRoutes)

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

  httpServer.listen(env.PORT, () => {
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
