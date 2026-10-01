/**
 * Escenarios que Kiri Coach puede simular desde el chat.
 *
 * La IA solo reconoce QUÉ quiere simular el usuario y con qué datos; las
 * cifras las calcula el frontend con el mismo código de los simuladores de
 * Obligaciones y de Ahorro (y con la distribución real del periodo), así el
 * chat y los simuladores nunca dicen números distintos.
 */

export const TIPOS_SIMULACION = ['ahorro_futuro', 'ahorro_meta', 'compra_cuotas'] as const
export type TipoSimulacion = typeof TIPOS_SIMULACION[number]

export interface Simulacion {
  tipo: TipoSimulacion
  nombre: string | null
  /** ahorro_meta y compra_cuotas: lo que cuesta */
  monto: number | null
  /** ahorro_futuro: lo que ahorraría cada periodo (quincena o mes, según cobra) */
  aporte: number | null
  /** ahorro_futuro: durante cuántos meses */
  meses: number | null
  /** ahorro_meta: para cuándo (YYYY-MM-DD, futura) */
  fecha: string | null
  /** Lo que ya tiene ahorrado para esto */
  inicial: number | null
  /** Rendimiento efectivo anual en % (0 si no lo dice) */
  tasaAnual: number | null
}

export const ESQUEMA_SIMULACION = {
  type: 'OBJECT',
  nullable: true,
  description: 'Escenario para simular si el usuario pregunta "¿qué pasa si…?" de ahorro o de comprar a cuotas. null si no.',
  properties: {
    tipo: { type: 'STRING', enum: [...TIPOS_SIMULACION] },
    nombre: { type: 'STRING', nullable: true, description: 'Qué quiere comprar o para qué ahorra, sin el precio (ej. "Celular", "Viaje", "Moto")' },
    monto: { type: 'NUMBER', nullable: true, description: 'OBLIGATORIO en ahorro_meta y compra_cuotas: el precio en pesos, entero ("4 millones" = 4000000)' },
    aporte: { type: 'NUMBER', nullable: true, description: 'OBLIGATORIO en ahorro_futuro: cuánto ahorraría cada quincena o mes (en su frecuencia de cobro), en pesos' },
    meses: { type: 'INTEGER', nullable: true, description: 'ahorro_futuro: durante cuántos meses (1 año = 12)' },
    fecha: { type: 'STRING', nullable: true, description: 'ahorro_meta: fecha objetivo YYYY-MM-DD, futura ("para diciembre" = el 31 del próximo diciembre)' },
    inicial: { type: 'NUMBER', nullable: true, description: 'Lo que ya tiene ahorrado para esto, si lo dice' },
    tasaAnual: { type: 'NUMBER', nullable: true, description: 'Rendimiento efectivo anual en % si lo menciona (CDT, cuenta)' },
  },
  // Todos presentes (null si no aplica): con solo "tipo" el modelo omitía el precio y la fecha
  required: ['tipo', 'nombre', 'monto', 'aporte', 'meses', 'fecha', 'inicial', 'tasaAnual'],
} as const

export const REGLAS_SIMULACION = `
CÓMO SIMULAR ESCENARIOS (campo "simulacion"):
- ahorro_futuro: "si ahorro X cada quincena/mes, ¿cuánto tendré en N meses?" → aporte (en SU
  frecuencia de cobro; si dice "al mes" y cobra quincenal, divide entre 2), meses, inicial si lo dice.
- ahorro_meta: "quiero comprar/viajar/tener X para tal fecha, ¿cuánto debo ahorrar?" → nombre,
  monto, fecha (YYYY-MM-DD futura; "en diciembre" = el próximo diciembre; "en 6 meses" = hoy + 6
  meses), inicial si ya tiene algo guardado para eso.
- compra_cuotas: "¿qué pasa si me compro X a cuotas / a crédito?", "¿me alcanza para una moto
  de 8 millones?" → nombre, monto. Es el Simulador de Escenarios de Obligaciones.
- Las cifras del escenario las calcula Kiri y aparecen en una tarjeta debajo de tu respuesta:
  NO calcules tú cuotas, totales ni fechas. En "respuesta" di en 1-2 frases qué simulaste y qué
  supusiste (ej. "Simulé ahorrar $200.000 por quincena durante un año; mira la tarjeta."), y si
  falta un dato imprescindible (el precio, la fecha, cuánto ahorraría) pregúntalo y deja
  "simulacion" en null.
- No propongas "acciones" en la misma respuesta de una simulación: desde la tarjeta el usuario
  puede crear el bolsillo o la deuda si le gusta el escenario.
`.trim()

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Valida lo que devolvió la IA. null si no hay nada que simular. */
export function normalizarSimulacion(raw: unknown, hoy = new Date()): Simulacion | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (!(TIPOS_SIMULACION as readonly string[]).includes(String(s.tipo))) return null
  const tipo = s.tipo as TipoSimulacion
  const monto = num(s.monto)
  const aporte = num(s.aporte)
  const meses = num(s.meses)
  let fecha = typeof s.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.fecha) ? s.fecha : null
  // Una fecha pasada (o de hoy) no sirve para una meta
  if (fecha && new Date(`${fecha}T23:59:59`) <= hoy) fecha = null
  const tasa = num(s.tasaAnual)
  const out: Simulacion = {
    tipo,
    nombre: typeof s.nombre === 'string' && s.nombre.trim() ? s.nombre.trim().slice(0, 50) : null,
    monto: monto ? Math.min(Math.round(monto), 5_000_000_000) : null,
    aporte: aporte ? Math.min(Math.round(aporte), 5_000_000_000) : null,
    meses: meses ? Math.min(Math.round(meses), 600) : null,
    fecha,
    inicial: num(s.inicial) ? Math.min(Math.round(num(s.inicial)!), 5_000_000_000) : null,
    tasaAnual: tasa ? Math.min(tasa, 50) : null,
  }
  // Sin lo mínimo no hay escenario (la IA debió preguntar)
  if (tipo === 'ahorro_futuro' && !out.aporte) return null
  if ((tipo === 'ahorro_meta' || tipo === 'compra_cuotas') && !out.monto) return null
  return out
}
