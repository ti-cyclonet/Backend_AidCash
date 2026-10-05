/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Misiones diarias/semanales y cofre de recompensa
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 3 misiones diarias fijas + 1 semanal, todas ligadas a acciones reales que ya
 * pasan por el backend (ver recordMissionAction, llamado desde las rutas que
 * hacen la acción de verdad — nunca desde el cliente).
 *
 * El progreso se guarda por `periodo` (string) en vez de resetearse con un cron:
 * "2026-08-29" para diarias, "2026-W35" para la semanal. Si no existe la fila
 * de hoy/esta semana, se crea al leer (upsert-on-read) — mismo patrón que ya
 * usa el proyecto en SavingsHistory/ImpulseExpense.periodo.
 *
 * La recompensa del cofre (pickReward) es aleatoria y ponderada, y SOLO corre
 * acá — nunca en el cliente, porque si el cálculo de probabilidades viviera en
 * el navegador cualquiera podría editar el JS y forzarse la recompensa rara.
 */

import { prisma } from '../config/database.js'
import { pushMissionReady, pushBadgeUnlocked } from './push.js'

/**
 * Insignias que se desbloquean por racha de días — DEBE calzar con los `id`
 * y `minStreak` de BADGES en Frontend_AidCash/src/hooks/use-streaks.ts (esa
 * lista es la fuente de la verdad para nombre/ícono/copy; esta solo decide
 * CUÁNDO se otorgan, porque el otorgamiento tiene que pasar por el server).
 */
const STREAK_BADGES: { id: string; nombre: string; minStreak: number }[] = [
  { id: 'primer_periodo', nombre: 'Primer Paso', minStreak: 1 },
  { id: 'dos_periodos', nombre: 'Vas Bien', minStreak: 3 },
  { id: 'tres_periodos', nombre: 'Racha de una Semana', minStreak: 7 },
  { id: 'cuatro_periodos', nombre: 'Hábito Formado', minStreak: 14 },
  { id: 'seis_periodos', nombre: 'Disciplina de Acero', minStreak: 30 },
  { id: 'doce_periodos', nombre: 'Leyenda Financiera', minStreak: 100 },
]

export type MissionKey =
  | 'gasto_hormiga' | 'pagar_obligacion' | 'categorizar' | 'racha_semanal'
  | 'registrar_obligacion' | 'registrar_ingreso_real' | 'registrar_ahorro' | 'invitar_amigo'
  | ReferralMissionKey
export type ReferralMissionKey = 'referido_1' | 'referido_3' | 'referido_5' | 'referido_10' | 'referido_25'
export type OnboardingMissionKey = 'registrar_obligacion' | 'registrar_ingreso_real' | 'registrar_ahorro' | 'invitar_amigo'
export type RewardType = 'xp' | 'boost'

export interface MissionCatalogEntry {
  key: MissionKey
  title: string
  desc: string
  icon: string
  target: number
}

export const MISSION_CATALOG: MissionCatalogEntry[] = [
  { key: 'gasto_hormiga', title: 'Registra un gasto hormiga', desc: 'Anota cualquier gasto pequeño de hoy', icon: '🐜', target: 1 },
  { key: 'pagar_obligacion', title: 'Paga o abona una obligación', desc: 'Marca como pagada una deuda o un gasto fijo', icon: '💳', target: 1 },
  { key: 'categorizar', title: 'Organiza tus categorías', desc: 'Crea una categoría de presupuesto o asígnasela a un gasto fijo', icon: '📊', target: 1 },
]

export const WEEKLY_MISSION: MissionCatalogEntry = {
  key: 'racha_semanal',
  title: 'Racha perfecta',
  desc: 'Usa Kiri 7 días seguidos esta semana',
  icon: '🏆',
  target: 7,
}

/**
 * Misiones de "primeros pasos" — de una sola vez, no se renuevan. Usan el
 * mismo modelo `MissionProgress` que las diarias/semanal, pero con un
 * `periodo` FIJO ("onboarding", ver `ONBOARDING_PERIODO`) en vez de uno que
 * cambia cada día/semana — así cada una solo se puede completar y reclamar
 * una vez en la vida del usuario, sin tocar el schema.
 */
export const ONBOARDING_CATALOG: MissionCatalogEntry[] = [
  { key: 'registrar_obligacion', title: 'Registra tu primera obligación', desc: 'Añade una deuda o un gasto fijo en Obligaciones', icon: '🏛️', target: 1 },
  { key: 'registrar_ingreso_real', title: 'Registra tu sueldo real', desc: 'Registra un ingreso en Billetera para empezar a distribuir tu dinero', icon: '💰', target: 1 },
  { key: 'registrar_ahorro', title: 'Haz tu primer aporte de ahorro', desc: 'Deposita en un bolsillo de ahorro', icon: '🐷', target: 1 },
  { key: 'invitar_amigo', title: 'Invita a un amigo', desc: 'Envíale tu enlace de Kiri o conéctate con alguien en Social', icon: '🤝', target: 1 },
]

/**
 * Misiones de referidos — traer gente NUEVA a Kiri con tu enlace de
 * invitación: cada amigo que de verdad usa Kiri hace crecer tu árbol. Los
 * escalones son los mismos niveles de "Invita y gana" (lib/referidos.ts), y
 * cada uno se reclama una sola vez. El progreso es el conteo real de amigos
 * activos (3 movimientos en 2 días, o ya suscritos), no se infla desde el cliente.
 */
export const REFERRAL_CATALOG: (MissionCatalogEntry & { key: ReferralMissionKey; rewardXp: number })[] = [
  { key: 'referido_1', title: 'Tu primer amigo usa Kiri', desc: 'Un amigo que llegó con tu enlace registra sus primeros movimientos', icon: '💌', target: 1, rewardXp: 50 },
  { key: 'referido_3', title: '3 amigos usan Kiri', desc: 'Tres amigos activos con tu enlace · 1 mes gratis de tu plan', icon: '🤝', target: 3, rewardXp: 100 },
  { key: 'referido_5', title: '5 amigos usan Kiri', desc: 'Cinco amigos activos con tu enlace · insignia Jardinero social', icon: '🌳', target: 5, rewardXp: 200 },
  { key: 'referido_10', title: '10 amigos usan Kiri', desc: 'Diez amigos activos · camino a Embajador Kiri', icon: '👑', target: 10, rewardXp: 400 },
  { key: 'referido_25', title: '25 amigos usan Kiri', desc: 'Veinticinco amigos activos · camino a KIRI PRO por 1 año', icon: '🏆', target: 25, rewardXp: 800 },
]
export const REFERRAL_PERIODO = 'referidos'

const ONBOARDING_REWARD_XP = 25

export interface MissionView {
  key: MissionKey
  title: string
  desc: string
  icon: string
  target: number
  progress: number
  claimed: boolean
}

// ─── Periodo ────────────────────────────────────────────────────────────────

/**
 * "2026-08-29" — periodo de las misiones diarias, en la fecha LOCAL (el
 * servidor corre con TZ=America/Bogota). Antes salía de toISOString (UTC):
 * en Colombia las misiones "de hoy" se renovaban a las 7 PM, no a medianoche.
 */
export function todayPeriodo(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** YYYY-MM-DD de una fecha cualquiera, para comparar días de calendario sin
 * arrastrar la hora (streakUltimoCheck es @db.Date, así que ya viene así). */
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Registra la "racha de días" (User.streakActual) — la misma que ya lee la
 * misión semanal "racha_semanal" (getMissionsForUser, tope en 7 días) y que
 * la UI de Jardín/Misiones siempre mostró como "X días". Antes nada la
 * incrementaba nunca: el único código que lo hacía vivía en el cliente
 * (useStreaks.incrementStreak) y ningún componente lo llamaba.
 *
 * Se llama desde recordMissionAction/recordOnboardingAction — el mismo
 * funnel server-side por el que ya pasa toda acción financiera real, así
 * que no hace falta tocar cada ruta por separado. Atómico y sin turnos de
 * ida y vuelta con el cliente: lee el estado actual UNA vez, calcula el
 * nuevo valor, y lo escribe — nunca confía en un streakActual que el cliente
 * le mande (eso era lo que producía el "última escritura gana" original).
 *
 * Como mucho suma 1 por día, sin importar cuántas acciones distintas
 * disparen misiones ese mismo día (ultimoCheck ya hoy → no hace nada). Si
 * hay un hueco de más de un día desde el último check-in, la racha se
 * reinicia en 1 en vez de en 0 — ya volviste a actuar hoy, así que hoy
 * cuenta como el primer día de una racha nueva.
 */
export async function recordDailyStreak(userId: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { streakActual: true, streakMejor: true, streakUltimoCheck: true },
    })
    if (!user) return

    const today = new Date()
    const todayKey = dateKey(today)
    const lastCheckKey = user.streakUltimoCheck ? dateKey(user.streakUltimoCheck) : null
    if (lastCheckKey === todayKey) return // ya se contó hoy

    const yesterday = new Date(today)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const continuing = lastCheckKey === dateKey(yesterday)

    const newStreak = continuing ? user.streakActual + 1 : 1
    const newBest = Math.max(newStreak, user.streakMejor)

    await prisma.user.update({
      where: { id: userId },
      data: { streakActual: newStreak, streakMejor: newBest, streakUltimoCheck: today },
    })

    // Insignias por racha — antes esto solo pasaba dentro del incrementStreak
    // muerto del cliente, así que nunca se otorgaban solas.
    const reached = STREAK_BADGES.filter((b) => newStreak >= b.minStreak)
    for (const badge of reached) {
      const existing = await prisma.userBadge.findUnique({
        where: { userId_badgeId: { userId, badgeId: badge.id } },
      })
      if (existing) continue
      await prisma.userBadge.create({ data: { userId, badgeId: badge.id } })
      pushBadgeUnlocked(userId, badge.nombre)
    }
  } catch (error) {
    console.error('[RecordDailyStreak]', error)
  }
}

/** "2026-W35" (ISO week) — periodo de la misión semanal */
export function weekPeriodo(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

/** Periodo fijo de las misiones de primeros pasos — nunca cambia, así cada
 * una se completa y reclama una sola vez en la vida del usuario. */
export const ONBOARDING_PERIODO = 'onboarding'

// ─── Progreso ───────────────────────────────────────────────────────────────

async function getOrCreateProgress(userId: string, missionKey: MissionKey, periodo: string, target: number) {
  // upsert: antes era buscar y luego crear, y si dos cosas lo hacían a la vez
  // (abrir Misiones mientras se guardaba un pago, o el Coach guardando varias
  // acciones juntas) la segunda chocaba con la llave única y ese avance se perdía.
  const where = { userId_missionKey_periodo: { userId, missionKey, periodo } }
  try {
    return await prisma.missionProgress.upsert({ where, update: {}, create: { userId, missionKey, periodo, target, progress: 0 } })
  } catch (e) {
    // Prisma no siempre la hace atómica: si otra petición la creó en ese
    // instante, se usa esa fila
    if ((e as { code?: string }).code === 'P2002') return prisma.missionProgress.findUniqueOrThrow({ where })
    throw e
  }
}

/**
 * Las filas de varias misiones de una vez: UNA lectura y, si falta alguna, UNA
 * inserción en lote. Antes GET /missions hacía ~11 upserts seguidos y, en la
 * prueba de carga (50 usuarios a la vez), tardaba ~0,8 s.
 */
async function asegurarFilas(userId: string, misiones: { key: MissionKey; periodo: string; target: number }[]) {
  const buscar = () => prisma.missionProgress.findMany({ where: { userId, OR: misiones.map(m => ({ missionKey: m.key, periodo: m.periodo })) } })
  let filas = await buscar()
  const faltan = misiones.filter(m => !filas.some(f => f.missionKey === m.key && f.periodo === m.periodo))
  if (faltan.length) {
    await prisma.missionProgress.createMany({ data: faltan.map(m => ({ userId, missionKey: m.key, periodo: m.periodo, target: m.target, progress: 0 })), skipDuplicates: true })
    filas = await buscar()
  }
  return (key: MissionKey, periodo: string) => filas.find(f => f.missionKey === key && f.periodo === periodo)!
}

/** +1 al progreso sin pasar del tope, atómico. true si con esto quedó completa. */
async function avanzar(id: string, target: number): Promise<boolean> {
  const r = await prisma.missionProgress.updateMany({ where: { id, progress: { lt: target } }, data: { progress: { increment: 1 } } })
  if (r.count === 0) return false
  const row = await prisma.missionProgress.findUnique({ where: { id }, select: { progress: true } })
  return (row?.progress ?? 0) >= target
}

/**
 * Registra que el usuario completó la acción real de una misión (+1 de progreso,
 * tope en `target`). Se llama desde las rutas que ya hacen la acción — nunca
 * falla la operación que la disparó: cualquier error acá solo se loguea.
 */
/**
 * Después de cada movimiento real: si quien lo hizo llegó invitado, ¿ya "usa
 * Kiri"? (lib/referidos.ts). Import dinámico para no crear un ciclo entre
 * módulos; nunca hace fallar la acción.
 */
function revisarReferido(userId: string): Promise<unknown> {
  return import('./referidos.js').then(m => m.revisarActivacionReferido(userId)).catch(() => {})
}

export async function recordMissionAction(userId: string, missionKey: Exclude<MissionKey, 'racha_semanal'>): Promise<void> {
  // Va ANTES del early-return de "esta misión ya llegó a su tope hoy": la
  // racha de días debe contar el check-in aunque esta misión puntual ya
  // estuviera completa, mientras sea una acción real del catálogo.
  await recordDailyStreak(userId)
  if (missionKey !== 'categorizar') await revisarReferido(userId)
  try {
    const entry = MISSION_CATALOG.find((m) => m.key === missionKey)
    if (!entry) return

    const periodo = todayPeriodo()
    const row = await getOrCreateProgress(userId, missionKey, periodo, entry.target)
    if (row.progress >= row.target) return

    // Recién se completó en este mismo llamado — avisar una sola vez.
    if (await avanzar(row.id, row.target)) {
      pushMissionReady(userId, entry.title)
    }
  } catch (error) {
    console.error('[RecordMissionAction]', error)
  }
}

/**
 * Registra que el usuario completó una misión de primeros pasos (progreso al
 * tope de una vez, `target` siempre es 1). Igual que `recordMissionAction`:
 * se llama desde las rutas que ya hacen la acción real, nunca desde el
 * cliente, y cualquier error acá solo se loguea.
 */
export async function recordOnboardingAction(userId: string, missionKey: OnboardingMissionKey): Promise<void> {
  await recordDailyStreak(userId)
  if (missionKey === 'registrar_ingreso_real' || missionKey === 'registrar_ahorro') await revisarReferido(userId)
  try {
    const entry = ONBOARDING_CATALOG.find((m) => m.key === missionKey)
    if (!entry) return

    const row = await getOrCreateProgress(userId, missionKey, ONBOARDING_PERIODO, entry.target)
    if (row.progress >= row.target) return

    if (await avanzar(row.id, row.target)) {
      pushMissionReady(userId, entry.title)
    }
  } catch (error) {
    console.error('[RecordOnboardingAction]', error)
  }
}

/** Amigos que llegaron con tu enlace y ya usan Kiri (activos o suscritos). */
function contarAmigosActivos(inviterId: string): Promise<number> {
  return prisma.user.count({ where: { invitedById: inviterId, OR: [{ referidoActivadoEn: { not: null } }, { primerPagoEn: { not: null } }] } })
}

/**
 * Un amigo invitado por `inviterId` empezó a usar Kiri o pagó: sincroniza los
 * escalones con el conteo real y avisa del que se acaba de completar.
 */
export async function syncReferralMissions(inviterId: string): Promise<void> {
  try {
    const total = await contarAmigosActivos(inviterId)
    for (const m of REFERRAL_CATALOG) {
      const row = await getOrCreateProgress(inviterId, m.key, REFERRAL_PERIODO, m.target)
      const nuevo = Math.min(total, m.target)
      if (row.claimedAt || nuevo <= row.progress) continue
      await prisma.missionProgress.update({ where: { id: row.id }, data: { progress: nuevo } })
      if (nuevo >= m.target) pushMissionReady(inviterId, m.title)
    }
  } catch (error) {
    console.error('[RecordReferral]', error)
  }
}

/** Misiones de referidos, listas para el frontend (progreso = conteo real). */
export async function getReferralMissionsForUser(userId: string): Promise<{ misiones: MissionView[]; referidos: number }> {
  const [total, fila] = await Promise.all([
    contarAmigosActivos(userId),
    asegurarFilas(userId, REFERRAL_CATALOG.map(m => ({ key: m.key, periodo: REFERRAL_PERIODO, target: m.target }))),
  ])
  const misiones = await Promise.all(
    REFERRAL_CATALOG.map(async (m) => {
      let row = fila(m.key, REFERRAL_PERIODO)
      const real = Math.min(total, m.target)
      if (!row.claimedAt && row.progress !== real) {
        row = await prisma.missionProgress.update({ where: { id: row.id }, data: { progress: real } })
      }
      return { key: m.key, title: m.title, desc: `${m.desc} · +${m.rewardXp} XP`, icon: m.icon, target: m.target, progress: row.progress, claimed: !!row.claimedAt }
    })
  )
  return { misiones, referidos: total }
}

/** Misiones de primeros pasos, listas para mostrar en el frontend. */
export async function getOnboardingMissionsForUser(userId: string): Promise<MissionView[]> {
  const fila = await asegurarFilas(userId, ONBOARDING_CATALOG.map(m => ({ key: m.key, periodo: ONBOARDING_PERIODO, target: m.target })))
  return ONBOARDING_CATALOG.map(m => {
    const row = fila(m.key, ONBOARDING_PERIODO)
    return { key: m.key, title: m.title, desc: m.desc, icon: m.icon, target: m.target, progress: row.progress, claimed: !!row.claimedAt }
  })
}

/** Misiones de hoy + la semanal, listas para mostrar en el frontend. */
export async function getMissionsForUser(userId: string): Promise<{ daily: MissionView[]; weekly: MissionView }> {
  const periodo = todayPeriodo()

  const [fila, user] = await Promise.all([
    asegurarFilas(userId, MISSION_CATALOG.map(m => ({ key: m.key, periodo, target: m.target }))),
    prisma.user.findUnique({ where: { id: userId }, select: { streakActual: true } }),
  ])
  const daily = MISSION_CATALOG.map(m => {
    const row = fila(m.key, periodo)
    return { key: m.key, title: m.title, desc: m.desc, icon: m.icon, target: m.target, progress: row.progress, claimed: !!row.claimedAt }
  })

  const week = weekPeriodo()
  const weeklyProgress = Math.min(user?.streakActual ?? 0, WEEKLY_MISSION.target)

  let weeklyRow = await prisma.missionProgress.findUnique({
    where: { userId_missionKey_periodo: { userId, missionKey: WEEKLY_MISSION.key, periodo: week } },
  })
  if (!weeklyRow) {
    weeklyRow = await prisma.missionProgress.create({
      data: { userId, missionKey: WEEKLY_MISSION.key, periodo: week, target: WEEKLY_MISSION.target, progress: weeklyProgress },
    })
  } else if (!weeklyRow.claimedAt && weeklyRow.progress !== weeklyProgress) {
    // La racha (User.streakActual) puede haber avanzado desde la última consulta — sincronizar
    weeklyRow = await prisma.missionProgress.update({ where: { id: weeklyRow.id }, data: { progress: weeklyProgress } })
  }

  const weekly: MissionView = {
    key: WEEKLY_MISSION.key,
    title: WEEKLY_MISSION.title,
    desc: WEEKLY_MISSION.desc,
    icon: WEEKLY_MISSION.icon,
    target: WEEKLY_MISSION.target,
    progress: weeklyRow.progress,
    claimed: !!weeklyRow.claimedAt,
  }

  return { daily, weekly }
}

// ─── Recompensas ──────────────────────────────────────────────────────────────

interface RewardOption {
  type: RewardType
  /** Monto de XP, u horas de duración si type === 'boost' */
  amount: number
  weight: number
  label: string
  icon: string
}

/**
 * Servidor únicamente — ver nota de seguridad al inicio del archivo.
 * Montos bajos a propósito (antes 15/30/50): el XP del árbol lo debe mover
 * sobre todo la constancia (racha), no unos pocos cofres.
 */
const REWARD_POOL: RewardOption[] = [
  { type: 'xp', amount: 5, weight: 45, label: '+5 XP', icon: '✨' },
  { type: 'xp', amount: 10, weight: 30, label: '+10 XP', icon: '✨' },
  { type: 'xp', amount: 20, weight: 15, label: '+20 XP', icon: '✨' },
  { type: 'boost', amount: 24, weight: 10, label: 'XP x2 por 24h', icon: '⚡' },
]

const WEEKLY_REWARD: RewardOption = { type: 'xp', amount: 60, weight: 100, label: '+60 XP', icon: '🏆' }
const ONBOARDING_REWARD: RewardOption = { type: 'xp', amount: ONBOARDING_REWARD_XP, weight: 100, label: `+${ONBOARDING_REWARD_XP} XP`, icon: '🌱' }

function pickReward(): RewardOption {
  const total = REWARD_POOL.reduce((s, r) => s + r.weight, 0)
  let roll = Math.random() * total
  for (const r of REWARD_POOL) {
    if (roll < r.weight) return r
    roll -= r.weight
  }
  return REWARD_POOL[0]
}

export interface RewardResult {
  type: RewardType
  amount: number
  label: string
  icon: string
}

export type ClaimResult =
  | { ok: true; reward: RewardResult }
  | { ok: false; error: string }

/**
 * Reclama una misión: valida progreso/estado contra la base de datos (nunca lo
 * que diga el cliente), elige la recompensa (aleatoria para diarias, fija y
 * mayor para la semanal), la aplica al usuario y deja constancia en RewardClaim.
 */
export async function claimMission(userId: string, missionKey: MissionKey): Promise<ClaimResult> {
  const isWeekly = missionKey === WEEKLY_MISSION.key
  const isOnboarding = ONBOARDING_CATALOG.some((m) => m.key === missionKey)
  const referral = REFERRAL_CATALOG.find((m) => m.key === missionKey)
  const entry = isWeekly ? WEEKLY_MISSION : isOnboarding ? ONBOARDING_CATALOG.find((m) => m.key === missionKey) : referral ?? MISSION_CATALOG.find((m) => m.key === missionKey)
  if (!entry) return { ok: false, error: 'Misión no reconocida' }

  const periodo = isWeekly ? weekPeriodo() : isOnboarding ? ONBOARDING_PERIODO : referral ? REFERRAL_PERIODO : todayPeriodo()

  const row = await prisma.missionProgress.findUnique({
    where: { userId_missionKey_periodo: { userId, missionKey, periodo } },
  })
  if (!row) return { ok: false, error: 'Misión no encontrada' }
  if (row.claimedAt) return { ok: false, error: 'Esta misión ya fue reclamada' }
  if (row.progress < row.target) return { ok: false, error: 'La misión todavía no está completa' }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { xpBoostExpiresAt: true } })
  const boostActive = !!(user?.xpBoostExpiresAt && user.xpBoostExpiresAt.getTime() > Date.now())

  const picked: RewardOption = isWeekly
    ? WEEKLY_REWARD
    : isOnboarding
      ? ONBOARDING_REWARD
      : referral
        ? { type: 'xp', amount: referral.rewardXp, weight: 100, label: `+${referral.rewardXp} XP`, icon: '💌' }
        : pickReward()
  const finalAmount = picked.type === 'xp' && boostActive ? picked.amount * 2 : picked.amount

  await prisma.$transaction([
    prisma.missionProgress.update({ where: { id: row.id }, data: { claimedAt: new Date() } }),
    prisma.rewardClaim.create({
      data: { userId, missionKey, periodo, rewardType: picked.type, rewardValue: finalAmount },
    }),
    prisma.user.update({
      where: { id: userId },
      data:
        picked.type === 'xp'
          ? { xpFromMissions: { increment: finalAmount } }
          : { xpBoostExpiresAt: new Date(Date.now() + finalAmount * 60 * 60 * 1000) },
    }),
  ])

  return {
    ok: true,
    reward: {
      type: picked.type,
      amount: finalAmount,
      label: picked.type === 'xp' ? `+${finalAmount} XP${boostActive ? ' (x2 boost!)' : ''}` : picked.label,
      icon: picked.icon,
    },
  }
}
