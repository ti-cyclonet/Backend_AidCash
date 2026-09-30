/**
 * Versiones vigentes de los documentos legales de Kiri (el texto está en
 * Frontend_AidCash/src/lib/legal/kiri-legal.ts: mantener las versiones iguales).
 *
 * La prueba legal de cada aceptación (versión, fecha, IP y navegador) la guarda
 * Authoriza en user_consents; Kiri guarda en el usuario qué versión aceptó
 * para saber a quién pedirle aceptar de nuevo cuando cambie el texto.
 */
import type { Request } from 'express'

export const LEGAL_VERSIONS = {
  terms: 'kiri-terminos-2026-09-30',
  habeasData: 'kiri-datos-2026-09-30',
} as const

export interface ConsentBody {
  acceptTerms?: boolean
  acceptHabeasData?: boolean
  termsVersion?: string
  habeasDataVersion?: string
}

/** true si aceptó ambos documentos en sus versiones vigentes. */
export function aceptaVersionesVigentes(body: ConsentBody | undefined): boolean {
  return body?.acceptTerms === true && body?.acceptHabeasData === true
    && body.termsVersion === LEGAL_VERSIONS.terms && body.habeasDataVersion === LEGAL_VERSIONS.habeasData
}

export function consentimientoPendiente(user: { terminosVersion: string | null; datosVersion: string | null }): boolean {
  return user.terminosVersion !== LEGAL_VERSIONS.terms || user.datosVersion !== LEGAL_VERSIONS.habeasData
}

/** Campos que se envían a Authoriza: versiones + IP/navegador reales del usuario. */
export function consentPayload(req: Request) {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
  return {
    acceptTerms: true,
    acceptHabeasData: true,
    termsVersion: LEGAL_VERSIONS.terms,
    habeasDataVersion: LEGAL_VERSIONS.habeasData,
    consentMeta: {
      ipAddress: forwarded || req.ip || null,
      userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) || null,
    },
  }
}

/** Datos locales para marcar la aceptación en el usuario de Kiri. */
export function consentLocalData() {
  return { terminosVersion: LEGAL_VERSIONS.terms, datosVersion: LEGAL_VERSIONS.habeasData, consentimientoAt: new Date() }
}

/** Cabeceras para llamar a Authoriza como servicio (la IP del usuario viaja en consentMeta). */
export function authorizaInternalHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' }
}
