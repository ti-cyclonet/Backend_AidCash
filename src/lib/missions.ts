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
import { pushMissionReady } from './push.js'

export type MissionKey = 'gasto_hormiga' | 'pagar_obligacion' | 'categorizar' | 'racha_semanal'
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

/** "2026-08-29" — periodo de las misiones diarias */
export function todayPeriodo(): string {
  return new Date().toISOString().slice(0, 10)
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

// ─── Progreso ───────────────────────────────────────────────────────────────

async function getOrCreateProgress(userId: string, missionKey: MissionKey, periodo: string, target: number) {
  const existing = await prisma.missionProgress.findUnique({
    where: { userId_missionKey_periodo: { userId, missionKey, periodo } },
  })
  if (existing) return existing
  return prisma.missionProgress.create({
    data: { userId, missionKey, periodo, target, progress: 0 },
  })
}

/**
 * Registra que el usuario completó la acción real de una misión (+1 de progreso,
 * tope en `target`). Se llama desde las rutas que ya hacen la acción — nunca
 * falla la operación que la disparó: cualquier error acá solo se loguea.
 */
export async function recordMissionAction(userId: string, missionKey: Exclude<MissionKey, 'racha_semanal'>): Promise<void> {
  try {
    const entry = MISSION_CATALOG.find((m) => m.key === missionKey)
    if (!entry) return

    const periodo = todayPeriodo()
    const row = await getOrCreateProgress(userId, missionKey, periodo, entry.target)
    if (row.progress >= row.target) return

    const newProgress = Math.min(row.progress + 1, row.target)
    await prisma.missionProgress.update({
      where: { id: row.id },
      data: { progress: newProgress },
    })

    // Recién se completó en este mismo llamado — avisar una sola vez.
    if (newProgress >= row.target) {
      pushMissionReady(userId, entry.title)
    }
  } catch (error) {
    console.error('[RecordMissionAction]', error)
  }
}

/** Misiones de hoy + la semanal, listas para mostrar en el frontend. */
export async function getMissionsForUser(userId: string): Promise<{ daily: MissionView[]; weekly: MissionView }> {
  const periodo = todayPeriodo()

  const daily = await Promise.all(
    MISSION_CATALOG.map(async (m) => {
      const row = await getOrCreateProgress(userId, m.key, periodo, m.target)
      return { key: m.key, title: m.title, desc: m.desc, icon: m.icon, target: m.target, progress: row.progress, claimed: !!row.claimedAt }
    })
  )

  const week = weekPeriodo()
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { streakActual: true } })
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

/** Servidor únicamente — ver nota de seguridad al inicio del archivo. */
const REWARD_POOL: RewardOption[] = [
  { type: 'xp', amount: 15, weight: 45, label: '+15 XP', icon: '✨' },
  { type: 'xp', amount: 30, weight: 30, label: '+30 XP', icon: '✨' },
  { type: 'xp', amount: 50, weight: 15, label: '+50 XP', icon: '✨' },
  { type: 'boost', amount: 24, weight: 10, label: 'XP x2 por 24h', icon: '⚡' },
]

const WEEKLY_REWARD: RewardOption = { type: 'xp', amount: 150, weight: 100, label: '+150 XP', icon: '🏆' }

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
  const entry = isWeekly ? WEEKLY_MISSION : MISSION_CATALOG.find((m) => m.key === missionKey)
  if (!entry) return { ok: false, error: 'Misión no reconocida' }

  const periodo = isWeekly ? weekPeriodo() : todayPeriodo()

  const row = await prisma.missionProgress.findUnique({
    where: { userId_missionKey_periodo: { userId, missionKey, periodo } },
  })
  if (!row) return { ok: false, error: 'Misión no encontrada' }
  if (row.claimedAt) return { ok: false, error: 'Esta misión ya fue reclamada' }
  if (row.progress < row.target) return { ok: false, error: 'La misión todavía no está completa' }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { xpBoostExpiresAt: true } })
  const boostActive = !!(user?.xpBoostExpiresAt && user.xpBoostExpiresAt.getTime() > Date.now())

  const picked = isWeekly ? WEEKLY_REWARD : pickReward()
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
