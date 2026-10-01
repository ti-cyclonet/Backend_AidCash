import { Router, Request, Response } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { sendPushToUser, contarDispositivos } from '../lib/push.js'
import { env } from '../config/env.js'
import { recordOnboardingAction } from '../lib/missions.js'
import { planPocketDeduction, planPocketCredit, planDeduccionEnCascada, WALLET_POCKET_FIELD, type WalletPocket } from '../lib/wallet.js'
import { AuthorizaRejectedError, setAuthorizaAvatar, setAuthorizaName } from '../lib/authoriza-auth.js'
import { unirNombre } from '../lib/ingresos.js'
import { olvidarIdioma } from '../lib/i18n.js'

const router = Router()
router.use(authMiddleware)

// Rate limit para endpoints de wallet (máx 30 requests por minuto por usuario)
const walletLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => req.user?.userId ?? req.ip ?? 'unknown',
  message: { error: 'Demasiadas operaciones de billetera. Espera un momento.' },
})

// Rate limit para búsqueda de usuarios (máx 10 por minuto por usuario) — evita
// fuerza bruta probando correos/usuarios al azar.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: Request) => req.user?.userId ?? req.ip ?? 'unknown',
  message: { error: 'Demasiadas búsquedas. Espera un momento.' },
})

// ─── Schema ───────────────────────────────────────────────────────────────────

const updateProfileSchema = z.object({
  nombre: z.string().trim().min(2).max(160).optional(),
  // El correo NO se cambia desde Kiri: es con el que se entra por Authoriza y
  // del que salen el plan y el contrato. Antes se podía poner cualquiera (ej.
  // uno de la lista de acceso completo, o el de alguien con KIRI PRO) y quedar
  // con su plan. Si una app vieja lo manda, zod lo descarta sin error.
  username: z.string().min(3).max(20).regex(/^[a-z0-9_]+$/, 'Solo minúsculas, números y guión bajo').optional(),
  avatarUrl: z.string().max(700_000, 'La imagen es demasiado grande').nullable().optional(),
  ingresoBase: z.number().min(0).optional(),
  frecuenciaIngreso: z.enum(['mensual', 'quincenal']).optional(),
  // fijo = sueldo; variable = sin sueldo fijo (independiente, ventas, comisiones)
  tipoIngreso: z.enum(['fijo', 'variable']).optional(),
  // Idioma de la app (avisos, push, errores y Kiri Coach también)
  idioma: z.enum(['es', 'en']).optional(),
  // Quincenal con montos distintos (null = las dos quincenas iguales)
  ingresoQuincena1: z.number().min(0).nullable().optional(),
  ingresoQuincena2: z.number().min(0).nullable().optional(),
  diasPago: z.array(z.number().min(1).max(31)).max(2).optional(),
  onboardingDone: z.boolean().optional(),
  metaAhorroGlobal: z.number().min(0).optional(),
  fondoEmergenciaActual: z.number().min(0).optional(),
  // Nombre en partes: se guardan en Kiri y se sincronizan con Authoriza
  firstName: z.string().trim().max(60).optional(),
  secondName: z.string().trim().max(60).optional(),
  firstSurname: z.string().trim().max(60).optional(),
  secondSurname: z.string().trim().max(60).optional(),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
})

const balanceSchema = z.object({
  monto: z.number(),
  tipo: z.enum(['ingreso', 'reset']),
}).strict()

const walletIncomeSchema = z.object({
  monto: z.number().min(0.01),
  tipo: z.enum(['salario', 'extra']),
}).strict()

const saldoInicialSchema = z.object({
  monto: z.number().min(0.01),
}).strict()

const walletDeductSchema = z.object({
  monto: z.number().min(0.01),
  bolsillo: z.enum(['obligaciones', 'libre', 'ahorro']),
}).strict()

const walletWithdrawSchema = z.object({
  monto: z.number().min(0.01),
  bolsillo: z.enum(['obligaciones', 'libre', 'ahorro', 'endeudamiento']),
}).strict()

// ─── POST /users/guias — marcar una guía/tutorial como vista ──────────────────
// Así la guía de un módulo (o la bienvenida) sale solo la primera vez, en
// cualquier dispositivo. Volver a verla es desde Perfil → Guía de Kiri.

const guiaSchema = z.object({ guia: z.string().min(1).max(40) }).strict()

router.post('/guias', validate(guiaSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { guia } = req.body as { guia: string }
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { guiasVistas: true } })
    if (!u) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    // "*" (todas vistas) solo cubre la primera versión; "social@2" se guarda aparte
    if (!u.guiasVistas.includes(guia) && (guia.includes('@') || !u.guiasVistas.includes('*'))) {
      await prisma.user.update({ where: { id: userId }, data: { guiasVistas: { push: guia } } })
    }
    res.json({ ok: true })
  } catch (error) {
    console.error('[Guias]', error)
    res.status(500).json({ error: 'Error al guardar' })
  }
})

// ─── POST /users/avatar ───────────────────────────────────────────────────────
// Sube la foto a Authoriza (fuente compartida por todas las apps). El token de
// Kiri no sirve contra Authoriza, por eso el navegador no sube directo allá.

const avatarSchema = z.object({
  dataUrl: z.string().startsWith('data:image/', 'Formato de imagen inválido').max(12_000_000, 'La imagen es demasiado grande'),
})

router.post('/avatar', validate(avatarSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { id: true, correo: true } })
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' })
      return
    }
    const url = await setAuthorizaAvatar(user.correo, req.body.dataUrl)
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } })
    res.json({ url })
  } catch (error) {
    if (error instanceof AuthorizaRejectedError) {
      res.status(400).json({ error: error.message })
      return
    }
    console.error('[Avatar]', (error as Error).message)
    res.status(503).json({ error: 'No pudimos subir tu foto en este momento. Intenta de nuevo.' })
  }
})

// ─── PATCH /users/profile ─────────────────────────────────────────────────────

router.patch('/profile', validate(updateProfileSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { firstName, secondName, firstSurname, secondSurname, documentType: _dt, documentNumber: _dn, ...localData } = req.body

    // Nombre en partes: se guardan tal cual y `nombre` se arma con ellas
    if (firstName && firstSurname) {
      Object.assign(localData, {
        primerNombre: firstName, segundoNombre: secondName || null,
        primerApellido: firstSurname, segundoApellido: secondSurname || null,
        nombre: unirNombre({ primerNombre: firstName, segundoNombre: secondName, primerApellido: firstSurname, segundoApellido: secondSurname }),
      })
    }

    // Cambió el nombre completo sin las partes (otra pantalla): las partes
    // viejas ya no corresponden, se olvidan (se vuelven a pedir en Perfil)
    if (typeof localData.nombre === 'string' && !(firstName && firstSurname)) {
      const cur = await prisma.user.findUnique({ where: { id: userId }, select: { primerNombre: true, segundoNombre: true, primerApellido: true, segundoApellido: true } })
      if (cur?.primerNombre && unirNombre({ primerNombre: cur.primerNombre, segundoNombre: cur.segundoNombre ?? '', primerApellido: cur.primerApellido ?? '', segundoApellido: cur.segundoApellido ?? '' }).replace(/\s+/g, ' ').toLowerCase() !== localData.nombre.replace(/\s+/g, ' ').trim().toLowerCase()) {
        Object.assign(localData, { primerNombre: null, segundoNombre: null, primerApellido: null, segundoApellido: null })
      }
    }

    // Forma de recibir ingresos: se deja coherente
    if (localData.tipoIngreso !== undefined || localData.frecuenciaIngreso !== undefined || localData.ingresoQuincena1 !== undefined || localData.ingresoQuincena2 !== undefined) {
      const actual = await prisma.user.findUnique({ where: { id: userId }, select: { tipoIngreso: true, frecuenciaIngreso: true } })
      const tipo = localData.tipoIngreso ?? actual?.tipoIngreso ?? 'fijo'
      const frec = tipo === 'variable' ? 'mensual' : (localData.frecuenciaIngreso ?? actual?.frecuenciaIngreso ?? 'mensual')
      if (tipo === 'variable') {
        // Sin sueldo fijo: sin quincenas ni días de pago; el mes calendario es su periodo
        Object.assign(localData, { frecuenciaIngreso: 'mensual', ingresoQuincena1: null, ingresoQuincena2: null })
        if (localData.diasPago === undefined) localData.diasPago = [1]
      } else if (frec !== 'quincenal') {
        Object.assign(localData, { ingresoQuincena1: null, ingresoQuincena2: null })
      } else {
        const q1 = localData.ingresoQuincena1, q2 = localData.ingresoQuincena2
        if (q1 != null && q2 != null && q1 > 0 && q2 > 0) {
          // Si son iguales no hace falta guardarlas aparte; el mes = la suma
          localData.ingresoBase = q1 + q2
          if (q1 === q2) Object.assign(localData, { ingresoQuincena1: null, ingresoQuincena2: null })
        } else if (q1 !== undefined || q2 !== undefined) {
          Object.assign(localData, { ingresoQuincena1: null, ingresoQuincena2: null })
        }
      }
    }

    // Una foto nueva llega como data URL: se sube a Authoriza para que se vea en
    // todas las apps, y localmente se guarda solo la URL resultante.
    if (typeof localData.avatarUrl === 'string' && localData.avatarUrl.startsWith('data:image/')) {
      const owner = await prisma.user.findUnique({ where: { id: userId }, select: { correo: true } })
      try {
        localData.avatarUrl = await setAuthorizaAvatar(owner!.correo, localData.avatarUrl)
      } catch (err) {
        const msg = err instanceof AuthorizaRejectedError ? err.message : 'No pudimos subir tu foto en este momento. Intenta de nuevo.'
        res.status(err instanceof AuthorizaRejectedError ? 400 : 503).json({ error: msg })
        return
      }
    }

    // Update local Kiri DB (only local fields)
    const user = await prisma.user.update({
      where: { id: userId },
      data: localData,
      select: {
        id: true,
        nombre: true,
        correo: true,
        username: true,
        avatarUrl: true,
        primerNombre: true,
        segundoNombre: true,
        primerApellido: true,
        segundoApellido: true,
        ingresoBase: true,
        frecuenciaIngreso: true,
        tipoIngreso: true,
        ingresoQuincena1: true,
        ingresoQuincena2: true,
        idioma: true,
        onboardingDone: true,
        metaAhorroGlobal: true,
        saldoAhorroTotal: true,
        fondoEmergenciaActual: true,
        streakActual: true,
        streakMejor: true,
        cashBalance: true,
      },
    })

    if (localData.idioma !== undefined) olvidarIdioma(userId)

    // El nombre también vive en Authoriza (lo ven FactoNet y las demás apps).
    // No bloquea: si Authoriza no responde, en Kiri ya quedó guardado.
    if (firstName && firstSurname) {
      await setAuthorizaName(user.correo, { firstName, secondName: secondName || null, firstSurname, secondSurname: secondSurname || null })
    }

    res.json({ user })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' })
      return
    }
    console.error('[UpdateProfile]', error)
    res.status(500).json({ error: 'Error al actualizar perfil' })
  }
})

// ─── GET /users/search — buscar por @username o correo, coincidencia exacta ──
// Nunca devuelve `correo` en la respuesta (evita exponer de más en un buscador
// de personas), y solo hace match exacto — nunca `contains`/autocomplete.

router.get('/search', searchLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const method = req.query.method as string
    const value = (req.query.value as string | undefined)?.trim()

    if (!value || (method !== 'username' && method !== 'correo')) {
      res.status(400).json({ error: 'Búsqueda inválida' })
      return
    }

    const user = await prisma.user.findUnique({
      where: method === 'username' ? { username: value.toLowerCase() } : { correo: value.toLowerCase() },
      select: { id: true, nombre: true, username: true, avatarUrl: true },
    })

    res.json({ user: user ?? null })
  } catch (error) {
    console.error('[SearchUser]', error)
    res.status(500).json({ error: 'Error al buscar usuario' })
  }
})

// ─── PATCH /users/balance ─────────────────────────────────────────────────────
// tipo=ingreso: suma monto al cashBalance
// tipo=reset:   pone cashBalance a 0

router.patch('/balance', validate(balanceSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo } = req.body as { monto: number; tipo: 'ingreso' | 'reset' }

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true },
    })
    if (!current) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    const newBalance = tipo === 'reset'
      ? 0
      : Number(current.cashBalance) + monto

    const user = await prisma.user.update({
      where: { id: userId },
      data: { cashBalance: newBalance },
      select: { cashBalance: true },
    })

    res.json({ cashBalance: Number(user.cashBalance) })
  } catch (error) {
    console.error('[UpdateBalance]', error)
    res.status(500).json({ error: 'Error al actualizar balance' })
  }
})

// ─── Reparto de plata nueva en los 4 bolsillos de la billetera ─────────────────
// El Embudo: obligaciones del mes, ahorro según la presión del presupuesto,
// gasto libre (tope 15%) y el resto como capacidad de endeudamiento. Lo usan
// registrar un ingreso y el saldo inicial del test.
async function repartirEnBilletera(userId: string, monto: number) {
  // Obtener datos del usuario: cashBalance actual para calcular nuevo presupuesto total
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { cashBalance: true },
  })
  if (!user) return null

  // Obtener TODAS las obligaciones activas (totales mensuales)
  const [debts, fixedExpenses] = await Promise.all([
    prisma.debt.findMany({ where: { userId, estado: 'activa' }, select: { cuotaPeriodo: true } }),
    prisma.fixedExpense.findMany({ where: { userId }, select: { monto: true } }),
  ])

  // ═══ PRESUPUESTO TOTAL = cashBalance actual + nuevo ingreso ═══
  const currentCashBalance = Number(user.cashBalance) || 0
  const newBudgetTotal = currentCashBalance + monto

  const totalObligationsMonthly = debts.reduce((s, d) => s + Number(d.cuotaPeriodo), 0) +
                                  fixedExpenses.reduce((s, f) => s + Number(f.monto), 0)

  // Base para la distribución: el presupuesto total acumulado en la billetera
  const baseIncome = newBudgetTotal

  // ═══ DISTRIBUCIÓN INTELIGENTE — El Embudo (basada en presupuesto total) ═══
  const obligationsPct = (totalObligationsMonthly / baseIncome) * 100
  const isOverloaded = totalObligationsMonthly >= baseIncome

  let aObligaciones: number
  let aAhorro: number
  let aLibre: number
  let aEndeudamiento: number

  if (isOverloaded) {
    // Estado CRÍTICO: obligaciones superan o igualan el presupuesto total → todo va a obligaciones
    aObligaciones = monto
    aAhorro = 0
    aLibre = 0
    aEndeudamiento = 0
  } else {
    const remanente = baseIncome - totalObligationsMonthly
    const remanentePct = (remanente / baseIncome) * 100

    // Ahorro: escala según presión del presupuesto
    let savingsPct: number
    if (remanentePct >= 40) savingsPct = 20
    else if (remanentePct >= 25) savingsPct = 15
    else if (remanentePct >= 15) savingsPct = 10
    else savingsPct = 5

    // El ahorro NO puede superar el remanente real
    const targetSavingsAmount = (savingsPct / 100) * baseIncome
    const savingsAmount = Math.min(targetSavingsAmount, remanente)

    // Lo que queda tras ahorro
    const afterSavings = remanente - savingsAmount

    // Gasto libre: tope 15% del presupuesto total, pero limitado por lo disponible
    const maxDailyFreeAmount = (15 / 100) * baseIncome
    let dailyFreeAmount: number
    let debtCapacityAmount: number

    if (afterSavings <= maxDailyFreeAmount) {
      dailyFreeAmount = Math.max(0, afterSavings)
      debtCapacityAmount = 0
    } else {
      dailyFreeAmount = maxDailyFreeAmount
      debtCapacityAmount = afterSavings - maxDailyFreeAmount
    }

    // Convertir montos del embudo a proporciones del monto REAL registrado
    const totalDistrib = totalObligationsMonthly + savingsAmount + dailyFreeAmount + debtCapacityAmount
    if (totalDistrib > 0) {
      aObligaciones = Math.round((totalObligationsMonthly / totalDistrib) * monto * 100) / 100
      aAhorro = Math.round((savingsAmount / totalDistrib) * monto * 100) / 100
      aLibre = Math.round((dailyFreeAmount / totalDistrib) * monto * 100) / 100
      aEndeudamiento = Math.round((monto - aObligaciones - aAhorro - aLibre) * 100) / 100
    } else {
      aObligaciones = monto
      aAhorro = 0
      aLibre = 0
      aEndeudamiento = 0
    }
  }

  // Asegurar que no haya negativos por redondeo
  aEndeudamiento = Math.max(0, aEndeudamiento)

  console.log('[WalletIncome] Distribución:', { baseIncome: newBudgetTotal, obligationsPct: Math.round(obligationsPct), isOverloaded, aObligaciones, aAhorro, aLibre, aEndeudamiento, monto })
  return { aObligaciones, aAhorro, aLibre, aEndeudamiento }
}

// ─── POST /users/wallet/income ─────────────────────────────────────────────────
// Registra un ingreso real y lo distribuye automáticamente en los 4 bolsillos
// según los porcentajes de la distribución inteligente.
// La distribución usa el PRESUPUESTO TOTAL ACUMULADO (cashBalance + monto nuevo)
// como base, NO el ingreso mensual. Así la billetera tiene su propia distribución
// separada de Proyecciones.

router.post('/wallet/income', walletLimiter, validate(walletIncomeSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, tipo } = req.body as { monto: number; tipo: 'salario' | 'extra' }

    const reparto = await repartirEnBilletera(userId, monto)
    if (!reparto) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    const { aObligaciones, aAhorro, aLibre, aEndeudamiento } = reparto

    // Transacción: crear registro + actualizar wallet + cashBalance
    const [record, updated] = await prisma.$transaction([
      prisma.incomeRecord.create({
        data: { userId, monto, tipo, aAhorro, aObligaciones, aLibre, aEndeudamiento },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          cashBalance: { increment: monto },
          walletAhorro: { increment: aAhorro },
          walletObligaciones: { increment: aObligaciones },
          walletLibre: { increment: aLibre },
          walletEndeudamiento: { increment: aEndeudamiento },
        },
        select: {
          cashBalance: true,
          walletAhorro: true,
          walletObligaciones: true,
          walletLibre: true,
          walletEndeudamiento: true,
        },
      }),
    ])

    // Cualquier ingreso a la billetera cumple "Registra tu sueldo real" (la
    // misión dice "Registra un ingreso en Billetera"). Antes solo contaba
    // 'salario': quien registraba su plata como extra, por dictado o desde el
    // aviso de saldo insuficiente nunca la veía completarse.
    await recordOnboardingAction(userId, 'registrar_ingreso_real')

    res.status(201).json({
      record: { ...record, monto: Number(record.monto) },
      wallet: {
        cashBalance: Number(updated.cashBalance),
        ahorro: Number(updated.walletAhorro),
        obligaciones: Number(updated.walletObligaciones),
        libre: Number(updated.walletLibre),
        endeudamiento: Number(updated.walletEndeudamiento),
      },
    })

    // Push notification de confirmación (no bloquea la respuesta)
    sendPushToUser(userId, {
      title: tipo === 'salario' ? '💰 Sueldo registrado' : '💸 Ingreso extra registrado',
      body: `Se distribuyeron $${monto.toLocaleString('es-CO')} en tu billetera inteligente.`,
      tag: 'income-registered',
      url: '/gestion',
    }).catch(() => {})
  } catch (error) {
    console.error('[WalletIncome]', error)
    res.status(500).json({ error: 'Error al registrar ingreso' })
  }
})

// ─── POST /users/wallet/saldo-inicial ─────────────────────────────────────────
// El test inicial pregunta cuánta plata tiene HOY en total (bancos, Nequi,
// efectivo, hasta las monedas): es el punto de partida de su Sueldo Real y
// desde ahí cada gasto, pago e ingreso lo mueve. No es un ingreso (no va al
// historial ni al promedio de ingresos). Solo con la billetera en $0, para
// que no pise un saldo que ya viene llevando.

router.post('/wallet/saldo-inicial', walletLimiter, validate(saldoInicialSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto } = req.body as { monto: number }
    const actual = await prisma.user.findUnique({ where: { id: userId }, select: { cashBalance: true } })
    if (!actual) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    if (Number(actual.cashBalance) !== 0) {
      res.status(409).json({ error: 'Tu billetera ya tiene saldo: registra lo que te entre como un ingreso.' })
      return
    }
    const reparto = await repartirEnBilletera(userId, monto)
    if (!reparto) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    // Condicional: si dos peticiones llegan a la vez, solo una suma
    const r = await prisma.user.updateMany({
      where: { id: userId, cashBalance: 0 },
      data: {
        cashBalance: monto,
        walletAhorro: reparto.aAhorro,
        walletObligaciones: reparto.aObligaciones,
        walletLibre: reparto.aLibre,
        walletEndeudamiento: reparto.aEndeudamiento,
      },
    })
    if (r.count === 0) {
      res.status(409).json({ error: 'Tu billetera ya tiene saldo: registra lo que te entre como un ingreso.' })
      return
    }
    await recordOnboardingAction(userId, 'registrar_ingreso_real')
    res.status(201).json({
      wallet: { cashBalance: monto, ahorro: reparto.aAhorro, obligaciones: reparto.aObligaciones, libre: reparto.aLibre, endeudamiento: reparto.aEndeudamiento },
    })
  } catch (error) {
    console.error('[WalletSaldoInicial]', error)
    res.status(500).json({ error: 'Error al guardar tu saldo inicial' })
  }
})

// ─── DELETE /users/wallet/income/:id ──────────────────────────────────────────
// Elimina un ingreso registrado como si nunca hubiera existido: sale del
// historial y del balance, y la billetera pierde exactamente lo que ese
// ingreso le sumó (cashBalance y cada bolsillo según su distribución).

router.delete('/wallet/income/:id', walletLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const record = await prisma.incomeRecord.findFirst({ where: { id: String(req.params.id), userId } })
    if (!record) { res.status(404).json({ error: 'Ingreso no encontrado' }); return }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
    })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    const r2 = (n: number) => Math.round(n * 100) / 100
    const monto = Number(record.monto)
    const saldos: Record<WalletPocket, number> = {
      ahorro: Number(user.walletAhorro), obligaciones: Number(user.walletObligaciones),
      libre: Number(user.walletLibre), endeudamiento: Number(user.walletEndeudamiento),
    }
    const reparto: Record<WalletPocket, number> = {
      ahorro: Number(record.aAhorro), obligaciones: Number(record.aObligaciones),
      libre: Number(record.aLibre), endeudamiento: Number(record.aEndeudamiento),
    }
    // Cada bolsillo devuelve lo que recibió de este ingreso. Si de un bolsillo
    // ya se gastó esa plata, lo que falta sale de los demás (en cascada) para
    // que ningún bolsillo quede en negativo mientras otro sí la tiene.
    const desglose: Record<WalletPocket, number> = { ahorro: 0, obligaciones: 0, libre: 0, endeudamiento: 0 }
    let falta = r2(monto - Object.values(reparto).reduce((s, v) => s + v, 0))
    for (const p of Object.keys(reparto) as WalletPocket[]) {
      const tomar = Math.min(reparto[p], Math.max(0, saldos[p]))
      desglose[p] = r2(tomar)
      saldos[p] -= tomar
      falta = r2(falta + reparto[p] - tomar)
    }
    if (falta > 0) {
      const { desglose: extra } = planDeduccionEnCascada(saldos, falta)
      for (const [p, v] of Object.entries(extra)) desglose[p as WalletPocket] = r2(desglose[p as WalletPocket] + (v ?? 0))
    }
    const data: Record<string, unknown> = { cashBalance: { decrement: monto } }
    for (const p of Object.keys(desglose) as WalletPocket[]) {
      if (desglose[p] > 0) data[WALLET_POCKET_FIELD[p]] = { decrement: desglose[p] }
    }

    const [, updated] = await prisma.$transaction([
      prisma.incomeRecord.delete({ where: { id: record.id } }),
      prisma.user.update({
        where: { id: userId },
        data,
        select: { cashBalance: true, walletAhorro: true, walletObligaciones: true, walletLibre: true, walletEndeudamiento: true },
      }),
    ])

    res.json({
      message: 'Ingreso eliminado',
      monto,
      tipo: record.tipo,
      wallet: {
        cashBalance: Number(updated.cashBalance),
        ahorro: Number(updated.walletAhorro),
        obligaciones: Number(updated.walletObligaciones),
        libre: Number(updated.walletLibre),
        endeudamiento: Number(updated.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[WalletIncomeDelete]', error)
    res.status(500).json({ error: 'Error al eliminar el ingreso' })
  }
})

// ─── POST /users/wallet/deduct ────────────────────────────────────────────────
// Deduce un monto de un bolsillo específico (obligaciones o libre)

router.post('/wallet/deduct', walletLimiter, validate(walletDeductSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, bolsillo } = req.body as { monto: number; bolsillo: 'obligaciones' | 'libre' | 'ahorro' }

    // Verificar que hay suficiente saldo REAL antes de deducir. Ojo: se valida
    // contra cashBalance, no contra el bolsillo notional — este endpoint lo
    // usan operaciones (aportar al fondo de emergencia, registrar un ahorro,
    // un gasto hormiga) donde el dinero puede venir de cualquier parte de la
    // billetera, no solo de lo que ya estaba etiquetado en ese bolsillo.
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { cashBalance: true },
    })
    if (!current) { res.status(404).json({ error: 'Usuario no encontrado' }); return }
    if (Number(current.cashBalance) < monto) {
      res.status(400).json({ error: 'Saldo insuficiente', disponible: Number(current.cashBalance), requerido: monto })
      return
    }

    // cashBalance y el bolsillo SIEMPRE se descuentan por el mismo monto real
    // — nunca por dos topes distintos, que es lo que los desincronizaba antes.
    const user = await prisma.user.update({
      where: { id: userId },
      data: planPocketDeduction(bolsillo, monto),
      select: {
        cashBalance: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletLibre: true,
        walletEndeudamiento: true,
      },
    })

    res.json({
      wallet: {
        cashBalance: Math.max(0, Number(user.cashBalance)),
        ahorro: Math.max(0, Number(user.walletAhorro)),
        obligaciones: Math.max(0, Number(user.walletObligaciones)),
        libre: Math.max(0, Number(user.walletLibre)),
        endeudamiento: Math.max(0, Number(user.walletEndeudamiento)),
      },
    })
  } catch (error) {
    console.error('[WalletDeduct]', error)
    res.status(500).json({ error: 'Error al deducir del bolsillo' })
  }
})

// ─── POST /users/wallet/withdraw ──────────────────────────────────────────────
// El espejo de /wallet/deduct: dinero que vuelve a estar disponible (retirar
// de un bolsillo de ahorro, del fondo de emergencia, etc.) — antes este
// endpoint no existía y el frontend lo llamaba igual, perdiendo el dinero
// silenciosamente (404 nunca reportado al usuario).

router.post('/wallet/withdraw', walletLimiter, validate(walletWithdrawSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { monto, bolsillo } = req.body as { monto: number; bolsillo: 'obligaciones' | 'libre' | 'ahorro' | 'endeudamiento' }

    const user = await prisma.user.update({
      where: { id: userId },
      data: planPocketCredit(bolsillo, monto),
      select: {
        cashBalance: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletLibre: true,
        walletEndeudamiento: true,
      },
    })

    res.json({
      withdrawn: monto,
      wallet: {
        cashBalance: Math.max(0, Number(user.cashBalance)),
        ahorro: Math.max(0, Number(user.walletAhorro)),
        obligaciones: Math.max(0, Number(user.walletObligaciones)),
        libre: Math.max(0, Number(user.walletLibre)),
        endeudamiento: Math.max(0, Number(user.walletEndeudamiento)),
      },
    })
  } catch (error) {
    console.error('[WalletWithdraw]', error)
    res.status(500).json({ error: 'Error al acreditar el bolsillo' })
  }
})

// ─── GET /users/wallet ────────────────────────────────────────────────────────
// Devuelve el estado actual de la billetera

router.get('/wallet', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        cashBalance: true,
        walletAhorro: true,
        walletObligaciones: true,
        walletLibre: true,
        walletEndeudamiento: true,
      },
    })
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return }

    res.json({
      wallet: {
        cashBalance: Number(user.cashBalance),
        ahorro: Number(user.walletAhorro),
        obligaciones: Number(user.walletObligaciones),
        libre: Number(user.walletLibre),
        endeudamiento: Number(user.walletEndeudamiento),
      },
    })
  } catch (error) {
    console.error('[GetWallet]', error)
    res.status(500).json({ error: 'Error al obtener billetera' })
  }
})

// ─── POST /users/wallet/reset ─────────────────────────────────────────────────
// Resetea toda la billetera a 0

router.post('/wallet/reset', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    await prisma.user.update({
      where: { id: userId },
      data: {
        cashBalance: 0,
        walletAhorro: 0,
        walletObligaciones: 0,
        walletLibre: 0,
        walletEndeudamiento: 0,
      },
    })
    res.json({ wallet: { cashBalance: 0, ahorro: 0, obligaciones: 0, libre: 0, endeudamiento: 0 } })
  } catch (error) {
    console.error('[WalletReset]', error)
    res.status(500).json({ error: 'Error al resetear billetera' })
  }
})

// ─── GET /users/dashboard-summary ─────────────────────────────────────────────

router.get('/dashboard-summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const [user, debts, fixedExpenses, savingsHistory, extraIncomes, impulseExpenses] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          nombre: true,
          ingresoBase: true,
          frecuenciaIngreso: true,
          onboardingDone: true,
          metaAhorroGlobal: true,
          saldoAhorroTotal: true,
          fondoEmergenciaActual: true,
          streakActual: true,
          streakMejor: true,
          cashBalance: true,
          walletAhorro: true,
          walletObligaciones: true,
          walletLibre: true,
          walletEndeudamiento: true,
        },
      }),
      prisma.debt.findMany({ where: { userId, estado: 'activa' } }),
      prisma.fixedExpense.findMany({ where: { userId } }),
      prisma.savingsHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
      prisma.extraIncome.findMany({ where: { userId } }),
      prisma.impulseExpense.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ])

    res.json({
      user,
      debts,
      fixedExpenses,
      savingsHistory,
      extraIncomes,
      impulseExpenses,
    })
  } catch (error) {
    console.error('[DashboardSummary]', error)
    res.status(500).json({ error: 'Error al obtener datos del dashboard' })
  }
})

// ─── POST /users/push-test — "Enviar notificación de prueba" (Perfil) ─────────

router.post('/push-test', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const dispositivos = await contarDispositivos(userId)
    if (dispositivos > 0) {
      await sendPushToUser(userId, {
        title: '🔔 ¡Las notificaciones funcionan!',
        body: 'Así te avisaremos de pagos, ingresos, misiones y Social.',
        tag: 'push-test',
        url: '/perfil',
      })
    }
    res.json({ dispositivos })
  } catch (error) {
    console.error('[PushTest]', error)
    res.status(500).json({ error: 'No se pudo enviar la prueba' })
  }
})

// ─── POST /users/push-subscription ────────────────────────────────────────────
// Guarda la suscripción push del navegador del usuario

router.post('/push-subscription', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { subscription } = req.body as { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      res.status(400).json({ error: 'Suscripción inválida' })
      return
    }

    // Upsert: si ya existe el endpoint, actualizar
    await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      update: { userId, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      create: { userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    })

    res.json({ message: 'Suscripción guardada' })
  } catch (error) {
    console.error('[PushSubscription]', error)
    res.status(500).json({ error: 'Error al guardar suscripción' })
  }
})

export default router
