import { Router, Request, Response } from 'express'
import { consentPayload, consentLocalData, authorizaInternalHeaders } from '../lib/legal.js'
import bcrypt from 'bcryptjs'
import { authMiddleware, olvidarSesion } from '../middleware/auth.js'
import { requireInternalKey } from '../middleware/internal-key.js'
import { verifyCredentials } from '../lib/authoriza-auth.js'
import { env } from '../config/env.js'
import { prisma } from '../config/database.js'
import { tieneAccesoCompleto } from '../lib/acceso-completo.js'
import { acreditarReferido, premiarReferidoPorPago } from '../lib/invitaciones.js'
import { resolverPlan, invalidarPlan, otorgarInsigniaPro, descuentoInvitadoDisponible, tierDeNombre, DESCUENTO_INVITADO } from '../lib/planes.js'
import { resumenReferidos } from '../lib/referidos.js'
import { avisar } from '../lib/push.js'
import { z } from 'zod'
import { Prisma } from '@prisma/client'

const router = Router()

interface PlanLimit {
  variableName: string
  displayName: string
  maxValue: number
  targetApplication: string
  limitType: string
}

interface TenantLimitsResponse {
  contractId: string
  packageName: string
  isBillable: boolean
  startDate: string | null
  endDate: string | null
  limits: PlanLimit[]
}

/**
 * GET /api/plan — el plan EFECTIVO del usuario (lib/planes.ts):
 * su contrato en Authoriza, los días de PLUS ganados por invitar o el acceso
 * completo de QA. Incluye funciones (features) y topes (limits) con los que el
 * frontend muestra lo que tiene y lo que desbloquea, más su descuento de
 * invitado (si llegó con un enlace) y cómo van sus amigos suscritos.
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId
    // Primero el resumen de invitados: puede entregar premios pendientes que
    // cambian el plan (meses ganados), y así el plan ya sale actualizado
    const referidos = await resumenReferidos(userId)
    const [plan, descuentoInvitado, primerMesInvitado] = await Promise.all([
      resolverPlan(userId),
      descuentoInvitadoDisponible(userId),
      primerMesConDescuento(userId),
    ])
    if (plan.features.exclusiveBadges) otorgarInsigniaPro(userId, 'pro_jardin_dorado')
    return res.json({
      planName: plan.planName,
      tier: plan.tier,
      fuente: plan.fuente,
      contractId: plan.contractId,
      isBillable: plan.isBillable ?? false,
      features: plan.features,
      limits: plan.limites,
      hasPlan: true,
      pruebaHasta: plan.pruebaHasta ?? null,
      // Con un plan ganado encima de uno pago: lo que de verdad paga
      tierContrato: plan.tierContrato ?? null,
      // { PLUS: 50, PRO: 30 } si llegó invitado y aún no lo ha usado
      descuentoInvitado,
      // Ya pagó su primera factura con descuento de invitado: { pct, hasta } durante ese mes
      primerMesInvitado,
      // Invita y gana: amigos (registrados, activos, con plan), niveles, siguiente premio y premios ganados
      referidos: { ...referidos, suscritos: referidos.pagados, descuentoAmigo: DESCUENTO_INVITADO },
    })
  } catch (error: any) {
    console.error('[Plan] Error fetching plan:', error.message)
    return res.status(503).json({ error: 'No se pudo obtener la información del plan. Intente más tarde.' })
  }
})

/**
 * El invitado ya pagó su primera factura con el descuento: el aviso solo dura
 * ese primer mes (30 días desde el pago); después paga el precio normal.
 */
async function primerMesConDescuento(userId: string): Promise<{ pct: number; hasta: string } | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { invitedById: true, primerPagoEn: true, descuentoPrimerMes: true } })
  if (!u?.invitedById || !u.primerPagoEn || !u.descuentoPrimerMes) return null
  const hasta = new Date(u.primerPagoEn.getTime() + 30 * 86_400_000)
  return hasta > new Date() ? { pct: u.descuentoPrimerMes, hasta: hasta.toISOString() } : null
}

/** FREE / PLUS / PRO de un paquete de Kiri según el catálogo de Authoriza (null si no responde). */
async function tierDePaquete(packageId: string): Promise<'FREE' | 'PLUS' | 'PRO' | null> {
  try {
    const r = await fetch(`${env.AUTHORIZA_API_URL}/api/packages/landing?application=Kiri`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    const paquetes = await r.json() as { packageId?: string; id?: string; name?: string; displayName?: string }[]
    const p = Array.isArray(paquetes) ? paquetes.find(x => (x.packageId ?? x.id) === packageId) : null
    return p ? tierDeNombre(p.name || p.displayName) : null
  } catch {
    return null
  }
}

/**
 * GET /api/plan/available
 * Returns the available plans for upgrade (public landing data from Authoriza).
 */
router.get('/available', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const url = `${env.AUTHORIZA_API_URL}/api/packages/landing?application=Kiri`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Authoriza responded with status ${response.status}`)
    }

    const plans = await response.json()
    return res.json(plans)
  } catch (error: any) {
    console.error('[Plan] Error fetching available plans:', error.message)
    return res.status(503).json({
      error: 'No se pudieron obtener los planes disponibles.',
    })
  }
})

/**
 * POST /api/plan/upgrade
 * Self-service plan change. Validates password and upgrades the user's plan
 * in Authoriza. This triggers contract generation, adminInvoices role assignment,
 * and marks the user as Firmante (authorized signer).
 */
router.post('/upgrade', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.correo
    const { packageId, password, packageName, acceptTerms, acceptHabeasData, billingCycle } = req.body

    if (!packageId || !password) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere packageId y password.',
      })
    }

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        error: 'No se pudo identificar tu cuenta. Intenta iniciar sesión de nuevo.',
      })
    }

    // Invitado por un amigo: 50% en el primer mes de PLUS o 30% en PRO, solo en
    // pago mensual. El plan sale del catálogo de Authoriza por packageId (no
    // del nombre que manda el navegador: así nadie pide "PLUS" en un PRO).
    const anual = billingCycle === 'annual'
    let descuento = 0
    const disponible = await descuentoInvitadoDisponible((req as any).user.userId)
    if (disponible && !anual) {
      const tier = await tierDePaquete(packageId)
      if (tier === 'PLUS' || tier === 'PRO') descuento = disponible[tier]
    }

    // La aceptación de Términos + autorización de datos ES la firma del cliente
    // en el nuevo contrato (Authoriza la registra así): sin ella no se contrata.
    if (acceptTerms !== true || acceptHabeasData !== true) {
      return res.status(400).json({
        success: false,
        error: 'Debes aceptar los Términos y Condiciones y autorizar el tratamiento de tus datos para cambiar de plan.',
      })
    }

    // Call Authoriza's upgrade-plan endpoint (con la clave interna: Authoriza
    // solo acepta el descuento si viene del backend de Kiri)
    const upgradeUrl = `${env.AUTHORIZA_API_URL}/api/auth/upgrade-plan`
    // Al contratar se aceptan de nuevo los documentos vigentes (Authoriza guarda la prueba)
    const aceptaDocumentos = acceptTerms === true && acceptHabeasData === true
    const upgradeResponse = await fetch(upgradeUrl, {
      method: 'POST',
      headers: authorizaInternalHeaders(),
      body: JSON.stringify({
        ...(descuento > 0 ? { firstInvoiceDiscountPct: descuento } : {}),
        email: userEmail,
        password,
        packageId,
        ...(aceptaDocumentos ? consentPayload(req) : {}),
        // Mensual o anual (el anual es una sola factura por el año, con descuento)
        billingCycle: billingCycle === 'annual' ? 'annual' : 'monthly',
      }),
    })

    const upgradeData = await upgradeResponse.json() as any

    if (!upgradeResponse.ok) {
      return res.status(upgradeResponse.status).json({
        success: false,
        error: upgradeData.message || 'Error al cambiar de plan.',
      })
    }

    // User keeps access to Kiri while contract is pending approval.
    // Access will upgrade automatically when the contract is signed and activated.
    // NOTE: We do NOT deactivate the user here — they keep using the previous plan
    // until the new contract is fully signed and activated by Authoriza's webhook.

    // Recordarlo para mostrar en Mi plan "tu contrato está listo en FactoNet"
    await prisma.user.update({
      where: { id: (req as any).user.userId },
      data: {
        cambioPlan: { packageId, plan: typeof packageName === 'string' ? packageName.slice(0, 80) : null, ciclo: billingCycle === 'annual' ? 'anual' : 'mensual', fecha: new Date().toISOString(), firmado: aceptaDocumentos, ...(descuento > 0 ? { descuentoPrimerMes: descuento } : {}) },
        ...(aceptaDocumentos ? consentLocalData() : {}),
        // Si aún no ha pagado nada, el % que llevará su primera factura (o nada)
        ...(disponible ? { descuentoPrimerMes: descuento > 0 ? descuento : null } : {}),
      },
    }).catch(() => {})

    return res.json({
      success: true,
      message: upgradeData.message || 'Plan actualizado exitosamente.',
      descuentoPrimerMes: descuento || null,
    })
  } catch (error: any) {
    console.error('[Plan] Error upgrading plan:', error.message)
    return res.status(500).json({
      success: false,
      error: 'Error al procesar el cambio de plan. Intente más tarde.',
    })
  }
})

/**
 * POST /api/plan/upgrade-from-landing
 * Called from the landing page for users who exist in Kiri but NOT in Authoriza.
 * Validates password locally, creates the user in Authoriza if needed, then upgrades.
 */
router.post('/upgrade-from-landing', async (req: Request, res: Response) => {
  try {
    const { email, password, packageId, acceptTerms, acceptHabeasData, billingCycle } = req.body

    if (!email || !password || !packageId) {
      return res.status(400).json({ success: false, error: 'Todos los campos son requeridos.' })
    }
    // Igual que en Mi plan: aceptar Términos + autorización de datos es la
    // firma del cliente en el contrato nuevo (solo falta la del administrador)
    if (acceptTerms !== true || acceptHabeasData !== true) {
      return res.status(400).json({ success: false, error: 'Debes aceptar los Términos y Condiciones y autorizar el tratamiento de tus datos para contratar el plan.' })
    }

    // 1. Validate user exists locally and password is correct
    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado.' })
    }

    // Si la cuenta ya existe en Authoriza, SU contraseña es la única válida.
    // Solo las cuentas antiguas que existen únicamente en Kiri se validan con
    // el hash local — es el puente para migrarlas a Authoriza (ensure-kiri-user).
    let cred
    try {
      cred = await verifyCredentials(email, password)
    } catch {
      return res.status(503).json({ success: false, error: 'No pudimos validar tu cuenta en este momento. Intenta de nuevo.' })
    }
    const isValid = cred.exists
      ? cred.valid
      : await bcrypt.compare(password, user.passwordHash).catch(() => false)
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Contraseña incorrecta.' })
    }

    // 2. Register user in Authoriza (self-register with same email/password)
    //    Then call upgrade-plan
    const registerUrl = `${env.AUTHORIZA_API_URL}/api/auth/ensure-kiri-user`
    const registerRes = await fetch(registerUrl, {
      method: 'POST',
      // ensure-kiri-user exige la clave interna entre servicios
      headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' },
      body: JSON.stringify({ email, password, nombre: user.nombre }),
    })

    // Cuenta CycloNet existente con otra contraseña: no se toca, se informa
    if (registerRes.status === 409) {
      const conflict = await registerRes.json().catch(() => ({})) as any
      return res.status(409).json({
        success: false,
        error: conflict?.message || 'Ya tienes una cuenta CycloNet con este correo y otra contraseña.',
      })
    }

    // If user already exists in Authoriza or was just created, proceed with upgrade
    if (registerRes.ok) {
      // Call upgrade-plan
      const upgradeUrl = `${env.AUTHORIZA_API_URL}/api/auth/upgrade-plan`
      const upgradeRes = await fetch(upgradeUrl, {
        method: 'POST',
        // Como servicio: Authoriza guarda la IP/navegador del usuario con la aceptación
        headers: authorizaInternalHeaders(),
        body: JSON.stringify({
          email, password, packageId,
          ...consentPayload(req),
          billingCycle: billingCycle === 'annual' ? 'annual' : 'monthly',
        }),
      })
      const upgradeData = await upgradeRes.json() as any

      if (upgradeRes.ok && upgradeData.success) {
        // User keeps access while contract is pending — do NOT deactivate.
        // Se recuerda para Mi plan ("ya firmaste, falta el administrador").
        await prisma.user.update({
          where: { id: user.id },
          data: {
            cambioPlan: { packageId, plan: null, ciclo: billingCycle === 'annual' ? 'anual' : 'mensual', fecha: new Date().toISOString(), firmado: true },
            ...consentLocalData(),
          },
        }).catch(() => {})
        return res.json({ success: true, message: upgradeData.message })
      }

      return res.status(upgradeRes.status).json({
        success: false,
        error: upgradeData.message || 'Error al procesar el cambio de plan.',
      })
    }

    return res.status(500).json({
      success: false,
      error: 'No se pudo preparar tu cuenta para el cambio de plan. Contacta soporte.',
    })
  } catch (error: any) {
    console.error('[Plan] Error in upgrade-from-landing:', error.message)
    return res.status(500).json({ success: false, error: 'Error al procesar el cambio de plan.' })
  }
})

/**
 * POST /api/plan/activate-user
 * Webhook called by Authoriza when a Kiri contract is activated.
 * Reactivates the local user so they can access the app again.
 * Server-to-server: exige x-internal-key (INTERNAL_API_KEY).
 */
router.post('/activate-user', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const { email, contractId, planUpgraded, packageName } = req.body

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in Kiri.' })
    }

    // Set welcome flag for paid plan upgrade (shown as in-app notification)
    const welcomeFlag = planUpgraded ? (packageName || 'Kiri Plus') : null

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: true,
        ...(welcomeFlag ? { pendingWelcome: welcomeFlag, cambioPlan: Prisma.DbNull } : {}),
      },
    })

    console.log(`[Plan] User ${user.correo} activated (contract ${contractId || 'N/A'})${planUpgraded ? ' — plan upgraded to ' + welcomeFlag : ''}`)
    invalidarPlan(user.id, user.correo)

    // Authoriza llama aquí cuando la persona verifica su correo: si llegó con
    // un enlace de invitación, ahora sí cuenta para la misión de quien la
    // invitó (solo al activarse por primera vez, antes de su primer login).
    if (!user.isActive && user.invitedById && (await prisma.refreshToken.count({ where: { userId: user.id } })) === 0) {
      acreditarReferido(user.id).catch(() => {})
    }

    return res.json({ success: true, message: 'User activated successfully.' })
  } catch (error: any) {
    console.error('[Plan] Error activating user:', error.message)
    return res.status(500).json({ success: false, error: 'Error activating user.' })
  }
})

/**
 * GET /api/plan/welcome — check and clear pending welcome notification
 * Returns { pendingWelcome: string | null, planPrice: number | null } and clears the flag once read.
 */
router.get('/welcome', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId
    if (!userId) {
      return res.status(401).json({ pendingWelcome: null, planPrice: null })
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pendingWelcome: true } })
    if (!user || !user.pendingWelcome) {
      return res.json({ pendingWelcome: null, planPrice: null })
    }

    const welcomeFlag = user.pendingWelcome

    // Intentar obtener el precio del plan desde Authoriza
    let planPrice: number | null = null
    try {
      const url = `${env.AUTHORIZA_API_URL}/api/packages/landing?application=Kiri`
      const response = await fetch(url)
      if (response.ok) {
        const packages = await response.json() as Array<{ name?: string; displayName?: string; price?: number; isHighlighted?: boolean }>
        const matchedPlan = packages.find((p) =>
          (p.name || p.displayName || '').toLowerCase().includes(welcomeFlag.toLowerCase())
        ) || packages.find((p) => p.isHighlighted)
        if (matchedPlan && typeof matchedPlan.price === 'number') {
          planPrice = matchedPlan.price
        }
      }
    } catch {
      // silently ignore — price will be null
    }

    // Clear the flag so it only shows once
    await prisma.user.update({
      where: { id: userId },
      data: { pendingWelcome: null },
    })

    return res.json({ pendingWelcome: welcomeFlag, planPrice })
  } catch (error: any) {
    console.error('[Plan] Error checking welcome:', error.message)
    return res.json({ pendingWelcome: null, planPrice: null })
  }
})

/**
 * POST /api/plan/set-user-status
 * Webhook called by Authoriza when a user's status changes (block/unblock).
 * Authoriza is the source of truth for access control.
 * Server-to-server: exige x-internal-key (INTERNAL_API_KEY).
 * Body: { email, allowed: boolean }
 */
router.post('/set-user-status', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const { email, allowed } = req.body

    if (!email || typeof allowed !== 'boolean') {
      return res.status(400).json({ success: false, error: 'email and allowed (boolean) are required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found in Kiri.' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: allowed, ...(allowed ? {} : { sessionsValidAfter: new Date() }) },
    })

    // If blocking, revoke all active refresh tokens to force logout
    if (!allowed) {
      await prisma.refreshToken.deleteMany({ where: { userId: user.id } }).catch(() => {})
    }

    console.log(`[Plan] User ${user.correo} status updated: isActive=${allowed}`)
    invalidarPlan(user.id, user.correo)
    olvidarSesion(user.id)
    return res.json({ success: true, message: `User access ${allowed ? 'enabled' : 'disabled'}.` })
  } catch (error: any) {
    console.error('[Plan] Error setting user status:', error.message)
    return res.status(500).json({ success: false, error: 'Error updating user status.' })
  }
})

/**
 * POST /api/plan/set-avatar
 * Webhook called by Authoriza when a user's avatar changes (from any app).
 * Server-to-server: exige x-internal-key (INTERNAL_API_KEY).
 * Body: { email, url }
 */
router.post('/set-avatar', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const { email, url } = req.body
    if (!email || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ success: false, error: 'email and an http(s) url are required.' })
    }

    const result = await prisma.user.updateMany({ where: { correo: email }, data: { avatarUrl: url } })
    return res.json({ success: true, updated: result.count })
  } catch (error: any) {
    console.error('[Plan] Error setting avatar:', error.message)
    return res.status(500).json({ success: false, error: 'Error updating avatar.' })
  }
})

/**
 * POST /api/plan/revoke-sessions
 * Webhook called by Authoriza when a user's password changes or is reset there.
 * Closes every open Kiri session: deletes refresh tokens and rejects access
 * tokens issued before now (see middleware/auth.ts).
 * Server-to-server: exige x-internal-key (INTERNAL_API_KEY).
 * Body: { email }
 */
router.post('/revoke-sessions', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    if (!email) {
      return res.status(400).json({ success: false, error: 'email is required.' })
    }

    const user = await prisma.user.findUnique({ where: { correo: email } })
    if (!user) {
      // Cuenta sin perfil en Kiri: no hay sesiones que cerrar
      return res.json({ success: true, message: 'No Kiri user for this email.' })
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { sessionsValidAfter: new Date() } }),
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ])

    olvidarSesion(user.id)
    console.log(`[Plan] Sessions revoked for ${user.correo} (credentials changed in Authoriza)`)
    return res.json({ success: true, message: 'Sessions revoked.' })
  } catch (error: any) {
    console.error('[Plan] Error revoking sessions:', error.message)
    return res.status(500).json({ success: false, error: 'Error revoking sessions.' })
  }
})

// ─── FactoNet: contrato y facturas del plan ───────────────────────────────────
// El usuario entra a FactoNet con el MISMO correo y contraseña de Kiri
// (Authoriza es el dueño de las contraseñas y, al cambiarse a un plan pago, le
// asigna el rol de FactoNet para ver su contrato y sus facturas).

const fmtCOP = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`
const fmtFecha = (f?: string | null) => f ? new Date(`${f}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }) : null

/** GET /api/plan/factonet — datos para la sección de FactoNet en Mi plan */
router.get('/factonet', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: (req as any).user.userId },
      select: { correo: true, facturaPendiente: true, cambioPlan: true },
    })
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' })
    const base = env.FACTONET_URL.replace(/\/+$/, '')
    return res.json({
      url: `${base}/login`,
      correo: user.correo,
      facturaPendiente: user.facturaPendiente ?? null,
      cambioPlan: user.cambioPlan ?? null,
    })
  } catch (error: any) {
    console.error('[Plan] Error en /factonet:', error.message)
    return res.status(500).json({ error: 'No se pudo cargar la información de FactoNet.' })
  }
})

/**
 * POST /api/plan/factura-evento
 * Webhook de Authoriza (x-internal-key): una factura del plan de Kiri cambió
 * (emitida y pendiente por pagar, recordatorios, recargo, suspensión, pagada).
 * Se avisa en Kiri (campana + celular) y al tocar el aviso se abre Mi plan →
 * acceso a FactoNet.
 */
const facturaEventoSchema = z.object({
  email: z.string().email(),
  evento: z.enum(['emitida', 'vence_hoy', 'aviso_mora', 'recargo', 'suspendida', 'pagada', 'pago_rechazado']),
  factura: z.object({
    codigo: z.string().max(60),
    valor: z.number(),
    emitida: z.string().nullable().optional(),
    vence: z.string().nullable().optional(),
    periodo: z.string().nullable().optional(),
    estado: z.string().max(40).optional(),
    plan: z.string().max(80).nullable().optional(),
  }),
})

router.post('/factura-evento', requireInternalKey, async (req: Request, res: Response) => {
  try {
    const parsed = facturaEventoSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Datos de factura inválidos.' })
    const { email, evento, factura } = parsed.data

    const user = await prisma.user.findUnique({ where: { correo: email }, select: { id: true } })
    if (!user) return res.status(404).json({ success: false, error: 'User not found in Kiri.' })

    const valor = fmtCOP(factura.valor)
    const vence = fmtFecha(factura.vence)
    const avisos: Record<typeof evento, { title: string; body: string }> = {
      emitida: { title: `🧾 Tu factura de Kiri está lista: ${valor}`, body: `Factura ${factura.codigo}${vence ? `, vence el ${vence}` : ''}. Mírala y págala en FactoNet con tu mismo usuario de Kiri.` },
      vence_hoy: { title: `⏰ Hoy vence tu factura de Kiri (${valor})`, body: `Factura ${factura.codigo}. Págala en FactoNet para no generar recargos.` },
      aviso_mora: { title: `⚠️ Tu factura de Kiri está vencida`, body: `Factura ${factura.codigo} por ${valor}. Págala pronto en FactoNet para evitar el recargo por mora.` },
      recargo: { title: `⚠️ Tu factura de Kiri ya tiene recargo por mora`, body: `Factura ${factura.codigo}. Ponte al día en FactoNet para no suspender tu plan.` },
      suspendida: { title: `🚫 Tu plan de Kiri fue suspendido por falta de pago`, body: `Factura ${factura.codigo} por ${valor}. Paga en FactoNet para reactivarlo.` },
      pagada: { title: `✅ Pago confirmado: factura ${factura.codigo}`, body: `Recibimos tu pago de ${valor}. ¡Gracias!` },
      pago_rechazado: { title: `❌ No pudimos confirmar tu pago`, body: `Factura ${factura.codigo}. Revisa el comprobante y vuelve a reportarlo en FactoNet.` },
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        facturaPendiente: evento === 'pagada'
          ? Prisma.DbNull
          : { ...factura, evento, actualizada: new Date().toISOString() },
      },
    })

    invalidarPlan(user.id, email)
    const { title, body } = avisos[evento]
    await avisar(user.id, { title, body, url: '/mi-plan#factonet', tag: `factura-${factura.codigo}`, tipo: 'factura' })

    // Primera factura pagada: si llegó invitado, quien lo invitó gana 1 mes
    // gratis de su plan y se revisan sus niveles (lib/referidos.ts)
    const referido = evento === 'pagada' && factura.valor > 0 ? await premiarReferidoPorPago(user.id) : null
    return res.json({ success: true, ...(referido ? { referidoPremiado: referido.premiado } : {}) })
  } catch (error: any) {
    console.error('[Plan] Error en factura-evento:', error.message)
    return res.status(500).json({ success: false, error: 'Error al registrar el aviso de factura.' })
  }
})

export default router
