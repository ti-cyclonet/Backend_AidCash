import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'

const router = Router()
router.use(authMiddleware)

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Banks Routes — Base de datos colaborativa de entidades bancarias
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Los bancos verificados (esVerificado=true) son agregados por los administradores.
 * Los usuarios pueden agregar bancos nuevos (esVerificado=false) que quedan
 * disponibles para toda la comunidad.
 *
 * La tasa de interés se guarda como porcentaje MENSUAL:
 *   1.85 = 1.85% mensual ≈ 22.2% EA (Efectivo Anual)
 */

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createBankSchema = z.object({
  nombre: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(100),
  tasaInteresPromedio: z.number().min(0).max(100, 'La tasa no puede ser mayor a 100%'),
})

// ─── GET /banks — Listar todos los bancos ─────────────────────────────────────
// Devuelve la lista ordenada: verificados primero, luego por nombre

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const search = (req.query.search as string) ?? ''

    const banks = await prisma.bankEntity.findMany({
      where: search ? {
        nombre: { contains: search, mode: 'insensitive' },
      } : undefined,
      orderBy: [
        { esVerificado: 'desc' },
        { nombre: 'asc' },
      ],
      select: {
        id: true,
        nombre: true,
        tasaInteresPromedio: true,
        esVerificado: true,
      },
    })

    res.json({
      banks: banks.map(b => ({
        ...b,
        tasaInteresPromedio: Number(b.tasaInteresPromedio),
      })),
    })
  } catch (error) {
    console.error('[GetBanks]', error)
    res.status(500).json({ error: 'Error al obtener bancos' })
  }
})

// ─── POST /banks — Crear un banco nuevo (usuario) ─────────────────────────────
// Si el banco ya existe (por nombre), retorna el existente.
// Si no existe, lo crea como no verificado.

router.post('/', validate(createBankSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { nombre, tasaInteresPromedio } = req.body as { nombre: string; tasaInteresPromedio: number }

    // Verificar si ya existe (case-insensitive)
    const existing = await prisma.bankEntity.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    })

    if (existing) {
      res.json({
        bank: { ...existing, tasaInteresPromedio: Number(existing.tasaInteresPromedio) },
        isNew: false,
      })
      return
    }

    // Crear nuevo banco (no verificado — agregado por usuario)
    const bank = await prisma.bankEntity.create({
      data: {
        nombre: nombre.trim(),
        tasaInteresPromedio,
        esVerificado: false,
      },
    })

    res.status(201).json({
      bank: { ...bank, tasaInteresPromedio: Number(bank.tasaInteresPromedio) },
      isNew: true,
    })
  } catch (error) {
    console.error('[CreateBank]', error)
    res.status(500).json({ error: 'Error al crear banco' })
  }
})

export default router
