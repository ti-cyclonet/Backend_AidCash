/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Planes (FREE, PLUS, PRO) y el plan efectivo de cada usuario
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * La fuente de verdad de lo que incluye cada paquete es Authoriza
 * (Backend_Authoriza/src/seeds/kiri-plan-matrix.ts). Esta es la COPIA que usa
 * Kiri para:
 *   - el plan prestado del programa de invitados (prueba de 14 días, meses ganados),
 *   - cuando Authoriza no responde (se usa lo último conocido o FREE),
 *   - completar variables que un paquete viejo aún no tenga.
 * Si cambias un valor en Authoriza, cámbialo aquí también.
 *
 * Antes los límites solo se aplicaban a tokens emitidos por Authoriza (con
 * tenantId): quien entraba por el login de Kiri no tenía NINGÚN límite. Ahora
 * todo pasa por resolverPlan(), que busca el contrato por correo.
 */
import { prisma } from '../config/database.js'
import { env } from '../config/env.js'
import { tieneAccesoCompleto } from './acceso-completo.js'

export type Tier = 'FREE' | 'PLUS' | 'PRO'
export const ILIMITADO = 999999
const U = ILIMITADO

interface VarDef { displayName: string; tipo: 'feature' | 'quantity'; valores: Record<Tier, number> }

export const MATRIZ: Record<string, VarDef> = {
  budgetManagement: { displayName: 'Gestión de presupuesto', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  impulseExpenses: { displayName: 'Registro de gastos del día a día', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  debtsTracking: { displayName: 'Control de deudas', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  fixedExpenses: { displayName: 'Gastos fijos', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  savingsPockets: { displayName: 'Bolsillos de ahorro', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  emergencyFund: { displayName: 'Fondo de emergencia', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  extraIncomes: { displayName: 'Ingresos extras', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  gamification: { displayName: 'Árbol Kiri, misiones y racha', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  basicReports: { displayName: 'Balance e historial', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  aiCoach: { displayName: 'Kiri Coach con IA', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  socialConnections: { displayName: 'Conexiones sociales', tipo: 'feature', valores: { FREE: 1, PLUS: 1, PRO: 1 } },
  advancedReports: { displayName: 'Reportes en PDF', tipo: 'feature', valores: { FREE: 0, PLUS: 1, PRO: 1 } },
  debtStrategies: { displayName: 'Estrategias de deuda (Bola de nieve / Avalancha)', tipo: 'feature', valores: { FREE: 0, PLUS: 1, PRO: 1 } },
  p2pLoans: { displayName: 'Préstamos entre usuarios', tipo: 'feature', valores: { FREE: 0, PLUS: 1, PRO: 1 } },
  sharedDebts: { displayName: 'Deudas compartidas', tipo: 'feature', valores: { FREE: 0, PLUS: 1, PRO: 1 } },
  sharedPockets: { displayName: 'Bolsillos compartidos', tipo: 'feature', valores: { FREE: 0, PLUS: 1, PRO: 1 } },
  householdBudget: { displayName: 'Presupuesto del hogar en pareja', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  openBanking: { displayName: 'Conexión con tu banco', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  receiptItems: { displayName: 'Escáner: separar recibos por productos', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  savedScenarios: { displayName: 'Escenarios guardados en Proyecciones', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  exclusiveBadges: { displayName: 'Insignias exclusivas', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  prioritySupport: { displayName: 'Soporte prioritario', tipo: 'feature', valores: { FREE: 0, PLUS: 0, PRO: 1 } },
  nCategorias: { displayName: 'categorías de presupuesto', tipo: 'quantity', valores: { FREE: 5, PLUS: 20, PRO: U } },
  nDeudas: { displayName: 'deudas', tipo: 'quantity', valores: { FREE: 5, PLUS: U, PRO: U } },
  nGastosFijos: { displayName: 'gastos fijos', tipo: 'quantity', valores: { FREE: 8, PLUS: U, PRO: U } },
  nBolsillos: { displayName: 'bolsillos de ahorro', tipo: 'quantity', valores: { FREE: 3, PLUS: 10, PRO: U } },
  nMeDeben: { displayName: 'registros de "Me deben"', tipo: 'quantity', valores: { FREE: 3, PLUS: U, PRO: U } },
  nIngresosExtra: { displayName: 'ingresos extra', tipo: 'quantity', valores: { FREE: 2, PLUS: U, PRO: U } },
  nConexiones: { displayName: 'conexiones en Social', tipo: 'quantity', valores: { FREE: 2, PLUS: 20, PRO: U } },
  nBolsillosCompartidos: { displayName: 'bolsillos compartidos', tipo: 'quantity', valores: { FREE: 0, PLUS: 3, PRO: U } },
  nPrestamos: { displayName: 'préstamos entre usuarios', tipo: 'quantity', valores: { FREE: 0, PLUS: U, PRO: U } },
  mesesProyeccion: { displayName: 'meses de proyección', tipo: 'quantity', valores: { FREE: 3, PLUS: 24, PRO: 24 } },
  mesesHistorial: { displayName: 'meses de historial en Balance', tipo: 'quantity', valores: { FREE: 3, PLUS: 24, PRO: U } },
  iaMensajesMes: { displayName: 'mensajes con Kiri Coach al mes', tipo: 'quantity', valores: { FREE: 10, PLUS: 150, PRO: 500 } },
  iaDictadosMes: { displayName: 'dictados por voz al mes', tipo: 'quantity', valores: { FREE: 10, PLUS: 100, PRO: 300 } },
  iaEscaneosMes: { displayName: 'escaneos de recibos al mes', tipo: 'quantity', valores: { FREE: 3, PLUS: 30, PRO: 100 } },
}

export const NOMBRE_PLAN: Record<Tier, string> = { FREE: 'KIRI FREE', PLUS: 'KIRI PLUS', PRO: 'KIRI PRO' }
const ORDEN: Tier[] = ['FREE', 'PLUS', 'PRO']

/** 'prueba' = plan prestado por el programa de invitados (prueba del invitado o meses ganados; no hay prueba al registrarse solo ni PLUS por la pareja) */
export type FuentePlan = 'contrato' | 'gratis' | 'prueba' | 'acceso' | 'sin_conexion'

export interface PlanResuelto {
  tier: Tier
  planName: string
  fuente: FuentePlan
  features: Record<string, boolean>
  limites: Record<string, { displayName: string; maxValue: number }>
  contractId?: string
  isBillable?: boolean
  /** Hasta cuándo dura el plan prestado (prueba del invitado o meses ganados), si aplica */
  pruebaHasta?: string | null
  /** Con plan prestado encima de uno pago: el plan que de verdad paga */
  tierContrato?: Tier
}

/** "KIRI PRO", "CYCLON PLUS" (paquete maestro = PRO), "KIRI PLUS", resto FREE */
export function tierDeNombre(nombre: string | null | undefined): Tier {
  const n = (nombre ?? '').toUpperCase()
  if (n.includes('PRO') || n.includes('CYCLON')) return 'PRO'
  if (n.includes('PLUS')) return 'PLUS'
  return 'FREE'
}

function planDeMatriz(tier: Tier): Pick<PlanResuelto, 'features' | 'limites'> {
  const features: PlanResuelto['features'] = {}
  const limites: PlanResuelto['limites'] = {}
  for (const [k, v] of Object.entries(MATRIZ)) {
    if (v.tipo === 'feature') features[k] = v.valores[tier] === 1
    else limites[k] = { displayName: v.displayName, maxValue: v.valores[tier] }
  }
  return { features, limites }
}

/** Valor de una variable en un plan (según la matriz de Kiri). */
export function valorEnPlan(tier: Tier, variable: string): number {
  return MATRIZ[variable]?.valores[tier] ?? 0
}

/** El siguiente plan que mejora esta variable, para el mensaje "Con PLUS tienes 20". */
export function mejoraPara(variable: string, actual: Tier): { plan: string; tier: Tier; maxValue: number } | null {
  const v = MATRIZ[variable]
  if (!v) return null
  for (const t of ORDEN.slice(ORDEN.indexOf(actual) + 1)) {
    if (v.valores[t] > v.valores[actual]) return { plan: NOMBRE_PLAN[t], tier: t, maxValue: v.valores[t] }
  }
  return null
}

// ─── Contrato en Authoriza (por correo), con caché ───────────────────────────

interface InfoContrato { packageName: string; contractId?: string; isBillable?: boolean; variables: { variableName: string; maxValue: number; limitType?: string; displayName: string }[] }
const cacheContrato = new Map<string, { data: InfoContrato | null; expira: number; guardado: number }>()
const TTL = 5 * 60 * 1000
const TTL_RESPALDO = 24 * 60 * 60 * 1000

async function contratoKiri(correo: string): Promise<{ data: InfoContrato | null; ok: boolean }> {
  const c = cacheContrato.get(correo)
  if (c && c.expira > Date.now()) return { data: c.data, ok: true }
  try {
    const check = await fetch(`${env.AUTHORIZA_API_URL}/api/auth/check-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: correo }),
      signal: AbortSignal.timeout(6000),
    })
    if (!check.ok) throw new Error(`check-email ${check.status}`)
    const cd = await check.json() as { exists?: boolean; userId?: string }
    let data: InfoContrato | null = null
    if (cd.exists && cd.userId) {
      const r = await fetch(`${env.AUTHORIZA_API_URL}/api/contracts/tenant/${cd.userId}/limits?application=Kiri`, { signal: AbortSignal.timeout(6000) })
      if (r.ok) {
        const d = await r.json() as { packageName: string; contractId?: string; isBillable?: boolean; limits: { variableName: string; maxValue: number; limitType?: string; displayName: string; targetApplication: string }[] }
        data = { packageName: d.packageName, contractId: d.contractId, isBillable: d.isBillable, variables: (d.limits ?? []).filter(l => l.targetApplication?.toLowerCase() === 'kiri') }
      } else if (r.status !== 404) throw new Error(`limits ${r.status}`)
    }
    cacheContrato.set(correo, { data, expira: Date.now() + TTL, guardado: Date.now() })
    return { data, ok: true }
  } catch {
    // Authoriza caído: lo último conocido (hasta 24 h) o "sin conexión"
    if (c && Date.now() - c.guardado < TTL_RESPALDO) return { data: c.data, ok: true }
    return { data: null, ok: false }
  }
}

// ─── Plan efectivo ───────────────────────────────────────────────────────────

const cachePlan = new Map<string, { plan: PlanResuelto; expira: number }>()

/** Olvida el plan calculado (tras activar un contrato, empezar una prueba…) */
export function invalidarPlan(userId?: string, correo?: string) {
  if (userId) cachePlan.delete(userId)
  if (correo) cacheContrato.delete(correo)
}

async function planPropio(user: { id: string; correo: string; pruebaPlusHasta: Date | null }): Promise<PlanResuelto> {
  if (tieneAccesoCompleto(user.correo)) {
    return { tier: 'PRO', planName: 'KIRI PRO (Test)', fuente: 'acceso', ...planDeMatriz('PRO'), isBillable: false }
  }
  const { data, ok } = await contratoKiri(user.correo)
  const tier = data ? tierDeNombre(data.packageName) : 'FREE'
  const base = planDeMatriz(tier)
  // Lo que diga el paquete en Authoriza manda sobre la matriz local
  for (const v of data?.variables ?? []) {
    const def = MATRIZ[v.variableName]
    const esFeature = def ? def.tipo === 'feature' : v.limitType === 'feature'
    if (esFeature) base.features[v.variableName] = Number(v.maxValue) === 1
    else base.limites[v.variableName] = { displayName: v.displayName || def?.displayName || v.variableName, maxValue: Number(v.maxValue) }
  }
  return {
    tier, ...base,
    planName: data?.packageName ?? NOMBRE_PLAN.FREE,
    fuente: !ok ? 'sin_conexion' : data ? 'contrato' : 'gratis',
    contractId: data?.contractId, isBillable: data?.isBillable ?? false,
  }
}

/** Pareja (conexión PARTNER aceptada) del usuario, si tiene. */
async function parejaDe(userId: string) {
  const conn = await prisma.connection.findFirst({
    where: { status: 'ACCEPTED', role: 'PARTNER', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    include: { requester: { select: { id: true, nombre: true } }, addressee: { select: { id: true, nombre: true } } },
  })
  if (!conn) return null
  return conn.requesterId === userId ? conn.addressee : conn.requester
}

export async function resolverPlan(userId: string): Promise<PlanResuelto> {
  const c = cachePlan.get(userId)
  if (c && c.expira > Date.now()) return c.plan

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, correo: true, pruebaPlusHasta: true, pruebaProHasta: true } })
  if (!user) return { tier: 'FREE', planName: NOMBRE_PLAN.FREE, fuente: 'gratis', ...planDeMatriz('FREE') }

  let plan = await planPropio(user)

  // Plan prestado por el programa de invitados: PRO (meses ganados con 10 o 25
  // amigos) o PLUS (14 días de prueba del invitado, o un mes ganado en FREE).
  // Solo SUBE el plan: nunca baja uno pago (un PLUS que paga con meses de PRO
  // ganados usa PRO mientras duren). No hay PLUS gratis por la pareja.
  const ahora = new Date()
  const prestado: { tier: Tier; hasta: Date } | null =
    user.pruebaProHasta && user.pruebaProHasta > ahora ? { tier: 'PRO', hasta: user.pruebaProHasta }
      : user.pruebaPlusHasta && user.pruebaPlusHasta > ahora ? { tier: 'PLUS', hasta: user.pruebaPlusHasta }
        : null
  if (prestado && ORDEN.indexOf(prestado.tier) > ORDEN.indexOf(plan.tier)) {
    // Sin Authoriza el plan prestado igual vale (vive en Kiri). Se conserva
    // `sin_conexion` para que los límites sigan sin bloquear a nadie (un PRO
    // que paga no queda recortado por una caída de Authoriza).
    plan = {
      ...plan, tier: prestado.tier, ...planDeMatriz(prestado.tier), planName: NOMBRE_PLAN[prestado.tier],
      fuente: plan.fuente === 'sin_conexion' ? 'sin_conexion' : 'prueba',
      pruebaHasta: prestado.hasta.toISOString(),
      // Lo que paga (si paga): Mi plan muestra "PRO ganado · tu plan es PLUS"
      tierContrato: plan.fuente === 'contrato' ? plan.tier : undefined,
    }
  }

  cachePlan.set(userId, { plan, expira: Date.now() + 60 * 1000 })
  return plan
}

/**
 * El presupuesto del hogar es de PRO, pero lo usan los dos de la pareja:
 * basta con que uno de los dos lo tenga.
 */
export async function hogarHabilitado(userId: string): Promise<boolean> {
  const propio = await resolverPlan(userId)
  if (propio.features.householdBudget || propio.fuente === 'sin_conexion') return true
  const pareja = await parejaDe(userId)
  if (!pareja) return false
  return (await resolverPlan(pareja.id)).features.householdBudget === true
}

/** Primer día del mes local de hace (meses-1) meses — inicio del historial permitido. */
export function inicioHistorial(meses: number, now: Date = new Date()): Date | null {
  if (meses >= ILIMITADO) return null
  return new Date(now.getFullYear(), now.getMonth() - Math.max(0, meses - 1), 1)
}

// ─── Invitaciones ────────────────────────────────────────────────────────────
// El amigo invitado: 14 días de KIRI PLUS gratis y, cuando se suscribe, 50% en
// su primer mes de PLUS o 30% en PRO (solo pago mensual; se aplica en la
// primera factura, en Authoriza). Lo que gana quien invita está en
// lib/referidos.ts (bono de Kiri Coach, mes gratis y niveles sin tope).
export const DESCUENTO_INVITADO: Record<'PLUS' | 'PRO', number> = { PLUS: 50, PRO: 30 }

/** Descuento de invitado que aún puede usar (null si no llegó invitado o ya lo usó). */
export async function descuentoInvitadoDisponible(userId: string): Promise<typeof DESCUENTO_INVITADO | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { invitedById: true, descuentoReferidoUsado: true, primerPagoEn: true } })
  return u?.invitedById && !u.descuentoReferidoUsado && !u.primerPagoEn ? DESCUENTO_INVITADO : null
}

// ─── Insignias exclusivas de KIRI PRO ────────────────────────────────────────
export const INSIGNIAS_PRO = ['pro_jardin_dorado', 'pro_hogar_equipo', 'pro_estratega'] as const

/** Da una insignia PRO si el plan la incluye (idempotente, nunca falla). */
export async function otorgarInsigniaPro(userId: string, badgeId: typeof INSIGNIAS_PRO[number]): Promise<void> {
  try {
    const plan = await resolverPlan(userId)
    if (!plan.features.exclusiveBadges) return
    await prisma.userBadge.upsert({ where: { userId_badgeId: { userId, badgeId } }, create: { userId, badgeId }, update: {} })
  } catch { /* no bloquear */ }
}
