import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database.js'
import { authMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { belvoService } from '../services/belvo.service.js'

const router = Router()
router.use(authMiddleware)

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Open Banking Routes — Integración con Belvo
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Flujo:
 *   1. GET  /widget-token     → Genera token para el Connect Widget del frontend
 *   2. POST /links            → Registra el link_id después de que el usuario conecta
 *   3. POST /links/:id/sync   → Sincroniza cuentas y transacciones de un link
 *   4. GET  /links            → Lista los bancos conectados del usuario
 *   5. DELETE /links/:id      → Desconecta un banco
 *   6. GET  /transactions     → Transacciones sincronizadas del usuario
 */

// ─── Schemas ──────────────────────────────────────────────────────────────────

const registerLinkSchema = z.object({
  linkId: z.string().min(1, 'linkId es requerido'),
  institution: z.string().min(1, 'institution es requerido'),
  institutionType: z.enum(['bank', 'fiscal']).default('bank'),
  accessMode: z.enum(['single', 'recurrent']).default('recurrent'),
})

const syncSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD').optional(),
})

// ─── GET /open-banking/status — Estado de la integración ──────────────────────

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const configured = belvoService.isConfigured()
    res.json({
      configured,
      provider: 'belvo',
      message: configured
        ? 'Belvo está configurado y listo'
        : 'Faltan credenciales de Belvo (BELVO_SECRET_ID / BELVO_SECRET_PASSWORD)',
    })
  } catch (error) {
    console.error('[OpenBanking:Status]', error)
    res.status(500).json({ error: 'Error al verificar estado de Open Banking' })
  }
})

// ─── GET /open-banking/widget-token — Token para el Connect Widget ────────────

router.get('/widget-token', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!belvoService.isConfigured()) {
      res.status(503).json({ error: 'Open Banking no está configurado' })
      return
    }

    // Si se envía linkId, es para actualizar un link existente
    const linkId = req.query.linkId as string | undefined
    const result = await belvoService.createWidgetToken(linkId)

    if (result.error) {
      res.status(502).json({ error: result.error })
      return
    }

    res.json({ token: result.data!.access })
  } catch (error) {
    console.error('[OpenBanking:WidgetToken]', error)
    res.status(500).json({ error: 'Error al generar token del widget' })
  }
})

// ─── POST /open-banking/links — Registrar un link tras conectar en el widget ──

router.post('/links', validate(registerLinkSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const { linkId, institution, institutionType, accessMode } = req.body

    // Verificar que no exista ya
    const existing = await prisma.belvoLink.findUnique({ where: { linkId } })
    if (existing) {
      res.status(409).json({ error: 'Este banco ya está conectado', link: existing })
      return
    }

    // Registrar el link en nuestra DB
    const link = await prisma.belvoLink.create({
      data: {
        userId,
        linkId,
        institution,
        institutionType,
        accessMode,
        status: 'valid',
      },
    })

    res.status(201).json({ link, message: 'Banco conectado exitosamente' })
  } catch (error) {
    console.error('[OpenBanking:RegisterLink]', error)
    res.status(500).json({ error: 'Error al registrar conexión bancaria' })
  }
})

// ─── POST /open-banking/links/:id/sync — Sincronizar cuentas y transacciones ─

router.post('/links/:id/sync', validate(syncSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    // Verificar propiedad
    const link = await prisma.belvoLink.findFirst({ where: { id, userId } })
    if (!link) {
      res.status(404).json({ error: 'Conexión bancaria no encontrada' })
      return
    }

    // Fechas por defecto: último mes
    const now = new Date()
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
    const dateFrom = req.body.dateFrom || oneMonthAgo.toISOString().split('T')[0]
    const dateTo = req.body.dateTo || now.toISOString().split('T')[0]

    // ─── Sincronizar Cuentas ────────────────────────────────────────────────
    const accountsResult = await belvoService.retrieveAccounts(link.linkId)
    let accountsSynced = 0

    if (accountsResult.data) {
      for (const acc of accountsResult.data) {
        await prisma.belvoAccount.upsert({
          where: { accountId: acc.id },
          create: {
            belvoLinkId: link.id,
            accountId: acc.id,
            nombre: acc.name || 'Cuenta',
            tipo: mapAccountCategory(acc.category),
            numero: acc.number ? acc.number.slice(-4) : null,
            moneda: acc.currency || 'COP',
            balanceActual: acc.balance.current,
            balanceDisponible: acc.balance.available,
          },
          update: {
            nombre: acc.name || 'Cuenta',
            balanceActual: acc.balance.current,
            balanceDisponible: acc.balance.available,
          },
        })
        accountsSynced++
      }
    }

    // ─── Sincronizar Transacciones ──────────────────────────────────────────
    const txResult = await belvoService.retrieveTransactions(link.linkId, dateFrom, dateTo)
    let transactionsSynced = 0

    if (txResult.data) {
      for (const tx of txResult.data) {
        // Upsert para evitar duplicados
        await prisma.belvoTransaction.upsert({
          where: { transactionId: tx.id },
          create: {
            belvoLinkId: link.id,
            transactionId: tx.id,
            accountId: tx.account.id,
            fecha: new Date(tx.value_date),
            monto: tx.amount,
            tipo: tx.type,
            categoria: tx.category,
            descripcion: tx.description,
            comercio: tx.merchant?.name || null,
            status: tx.status || 'PROCESSED',
          },
          update: {
            monto: tx.amount,
            categoria: tx.category,
            status: tx.status || 'PROCESSED',
          },
        })
        transactionsSynced++
      }
    }

    // Actualizar timestamp de última sincronización
    await prisma.belvoLink.update({
      where: { id: link.id },
      data: { lastSyncAt: new Date() },
    })

    res.json({
      message: 'Sincronización completada',
      accountsSynced,
      transactionsSynced,
      dateFrom,
      dateTo,
    })
  } catch (error) {
    console.error('[OpenBanking:Sync]', error)
    res.status(500).json({ error: 'Error durante la sincronización' })
  }
})

// ─── GET /open-banking/links — Listar bancos conectados del usuario ───────────

router.get('/links', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId

    const links = await prisma.belvoLink.findMany({
      where: { userId },
      include: {
        accounts: {
          select: {
            id: true,
            nombre: true,
            tipo: true,
            numero: true,
            moneda: true,
            balanceActual: true,
            balanceDisponible: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({
      links: links.map(l => ({
        ...l,
        accounts: l.accounts.map(a => ({
          ...a,
          balanceActual: Number(a.balanceActual),
          balanceDisponible: a.balanceDisponible ? Number(a.balanceDisponible) : null,
        })),
      })),
    })
  } catch (error) {
    console.error('[OpenBanking:ListLinks]', error)
    res.status(500).json({ error: 'Error al obtener bancos conectados' })
  }
})

// ─── DELETE /open-banking/links/:id — Desconectar un banco ────────────────────

router.delete('/links/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const id = req.params.id as string

    const link = await prisma.belvoLink.findFirst({ where: { id, userId } })
    if (!link) {
      res.status(404).json({ error: 'Conexión bancaria no encontrada' })
      return
    }

    // Eliminar en Belvo (best effort — no bloquear si falla)
    await belvoService.deleteLink(link.linkId)

    // Eliminar de nuestra DB (cascade elimina accounts y transactions)
    await prisma.belvoLink.delete({ where: { id } })

    res.json({ message: 'Banco desconectado exitosamente' })
  } catch (error) {
    console.error('[OpenBanking:DeleteLink]', error)
    res.status(500).json({ error: 'Error al desconectar banco' })
  }
})

// ─── GET /open-banking/transactions — Transacciones sincronizadas ─────────────

router.get('/transactions', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId
    const limit = parseInt(req.query.limit as string) || 50
    const offset = parseInt(req.query.offset as string) || 0
    const tipo = req.query.tipo as string | undefined // INFLOW | OUTFLOW

    // Obtener IDs de links del usuario
    const userLinks = await prisma.belvoLink.findMany({
      where: { userId },
      select: { id: true },
    })

    if (userLinks.length === 0) {
      res.json({ transactions: [], total: 0 })
      return
    }

    const linkIds = userLinks.map(l => l.id)
    const where: Record<string, unknown> = { belvoLinkId: { in: linkIds } }
    if (tipo) where.tipo = tipo

    const [transactions, total] = await Promise.all([
      prisma.belvoTransaction.findMany({
        where,
        orderBy: { fecha: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.belvoTransaction.count({ where }),
    ])

    res.json({
      transactions: transactions.map(t => ({
        ...t,
        monto: Number(t.monto),
      })),
      total,
      limit,
      offset,
    })
  } catch (error) {
    console.error('[OpenBanking:Transactions]', error)
    res.status(500).json({ error: 'Error al obtener transacciones' })
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mapea la categoría de cuenta de Belvo a un tipo simplificado.
 */
function mapAccountCategory(category: string): string {
  const map: Record<string, string> = {
    'CHECKING_ACCOUNT': 'checking',
    'SAVINGS_ACCOUNT': 'savings',
    'CREDIT_CARD': 'credit_card',
    'LOAN_ACCOUNT': 'loan',
    'PENSION_FUND_ACCOUNT': 'pension',
    'UNCATEGORIZED': 'other',
  }
  return map[category] || 'other'
}

export default router
