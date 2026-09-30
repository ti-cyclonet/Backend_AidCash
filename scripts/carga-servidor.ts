/**
 * Servidor para la prueba de carga (lo arranca scripts/carga-qa.ts): las mismas
 * rutas que server.ts, sin crons ni límite de peticiones, en un puerto aparte.
 * Authoriza apunta a un puerto cerrado para no llamar servicios reales.
 */
import 'dotenv/config'

process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1'
const PUERTO = Number(process.env.CARGA_PUERTO ?? 4189)

async function main() {
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { traducirRespuestas } = await import('../src/lib/i18n.js')
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use(traducirRespuestas)
  const rutas: [string, string][] = [
    ['auth', 'auth'], ['users', 'user'], ['debts', 'debts'], ['fixed-expenses', 'fixed-expenses'], ['savings', 'savings'],
    ['extra-incomes', 'extra-incomes'], ['impulse-expenses', 'impulse'], ['emergency-fund', 'emergency-fund'],
    ['gamification', 'gamification'], ['missions', 'missions'], ['reports', 'reports'], ['connections', 'connections'],
    ['external-loans', 'external-loans'], ['notifications', 'notifications'], ['savings-pockets', 'savings-pockets'],
    ['budget-categories', 'budget-categories'], ['projections', 'projections'], ['plan', 'plan'], ['loans', 'loans'],
  ]
  for (const [ruta, mod] of rutas) app.use(`/api/${ruta}`, (await import(`../src/routes/${mod}.routes.js`)).default)
  app.use(errorHandler)
  app.listen({ port: PUERTO, backlog: 2048 }, () => console.log('LISTO'))
}
main()
