/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Acciones que propone la IA (chat, dictado y escáner)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Un solo formato para todo lo que la IA puede proponer. Nada se ejecuta en el
 * servidor: el frontend muestra cada acción en una tarjeta editable y solo al
 * confirmar llama a los mismos endpoints que usan los formularios de la app
 * (así cada acción dispara lo mismo: toasts, alertas de categoría, lluvia del
 * árbol, aviso a la pareja…).
 *
 * `normalizarAcciones` valida cada id contra el contexto real del usuario (la
 * IA puede inventar o equivocar un id), intenta ubicar por nombre lo que la IA
 * no ubicó, y marca en `faltan` lo que el usuario tiene que completar — por
 * ejemplo, si el escáner leyó el valor pero no a qué corresponde.
 */
import type { ContextoIA } from './contexto.js'

export const TIPOS_ACCION = [
  'gasto', 'ingreso', 'pago_obligacion', 'ahorro', 'crear_categoria', 'crear_deuda',
  'crear_gasto_fijo', 'crear_bolsillo', 'me_deben', 'abono_me_deben', 'sin_destino',
] as const
export type TipoAccion = typeof TIPOS_ACCION[number]

export const ICONOS_CATEGORIA = ['utensils', 'car', 'gamepad', 'dumbbell', 'heart', 'shopping', 'wifi', 'education', 'paw', 'home', 'baby', 'plane', 'gift', 'tools', 'more'] as const

export interface Accion {
  id: string
  tipo: TipoAccion
  nombre: string
  monto: number
  // gasto
  categoriaId?: string | null
  categoriaNueva?: string | null
  esHormiga?: boolean | null
  hogarCategoriaId?: string | null
  // ingreso
  tipoIngreso?: 'salario' | 'extra' | null
  // pago_obligacion
  obligacionId?: string | null
  obligacionTipo?: 'deuda' | 'fijo' | null
  // ahorro
  bolsilloId?: string | null
  // crear_deuda / crear_gasto_fijo
  cuota?: number | null
  diaPago?: number | null
  tasaMensual?: number | null
  esTarjeta?: boolean | null
  frecuencia?: 'mensual' | 'quincenal' | 'semanal' | 'anual' | null
  // crear_categoria
  icono?: string | null
  // me_deben / abono_me_deben
  persona?: string | null
  fechaCompromiso?: string | null
  meDebenId?: string | null
  /** Lo que el usuario debe completar antes de confirmar */
  faltan: string[]
}

/** Esquema de UNA acción para responseSchema de Gemini. */
export const ESQUEMA_ACCION = {
  type: 'OBJECT',
  properties: {
    tipo: { type: 'STRING', enum: [...TIPOS_ACCION] },
    nombre: { type: 'STRING', description: 'Descripción corta (ej. "Almuerzo", "Arriendo", "Viaje a Cartagena")' },
    monto: { type: 'NUMBER', description: 'Valor en pesos, número entero sin puntos. En crear_categoria es el límite; en crear_bolsillo la meta; en crear_deuda el saldo total.' },
    categoriaId: { type: 'STRING', nullable: true, description: 'id EXACTO de una categoría de presupuesto del contexto (solo gasto)' },
    categoriaNueva: { type: 'STRING', nullable: true, description: 'Nombre de una categoría nueva a crear para este gasto, solo si el usuario lo pide o ninguna existente sirve' },
    esHormiga: { type: 'BOOLEAN', nullable: true },
    hogarCategoriaId: { type: 'STRING', nullable: true, description: 'id EXACTO de una categoría del presupuesto del hogar, solo si el gasto es del hogar con la pareja' },
    tipoIngreso: { type: 'STRING', enum: ['salario', 'extra'], nullable: true },
    obligacionId: { type: 'STRING', nullable: true, description: 'id EXACTO de una deuda o gasto fijo del contexto (pago_obligacion)' },
    bolsilloId: { type: 'STRING', nullable: true, description: 'id EXACTO de un bolsillo de ahorro del contexto (ahorro)' },
    cuota: { type: 'NUMBER', nullable: true },
    diaPago: { type: 'INTEGER', nullable: true },
    tasaMensual: { type: 'NUMBER', nullable: true, description: 'Tasa de interés MENSUAL en %' },
    esTarjeta: { type: 'BOOLEAN', nullable: true },
    frecuencia: { type: 'STRING', enum: ['mensual', 'quincenal', 'semanal', 'anual'], nullable: true },
    icono: { type: 'STRING', enum: [...ICONOS_CATEGORIA], nullable: true },
    persona: { type: 'STRING', nullable: true },
    fechaCompromiso: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' },
    meDebenId: { type: 'STRING', nullable: true, description: 'id EXACTO de un registro de "Me deben" del contexto (abono_me_deben)' },
  },
  required: ['tipo', 'nombre', 'monto'],
} as const

/** Reglas de cómo elegir cada acción — se comparten entre chat, dictado y escáner. */
export const REGLAS_ACCIONES = `
CÓMO PROPONER ACCIONES (campo "acciones"):
- gasto: compró/gastó/pagó algo que NO es una obligación registrada. Pon categoriaId con la categoría
  existente que mejor encaje (por nombre y sentido: "almuerzo" → Comida/Alimentación; "Uber" →
  Transporte). Si ninguna encaja deja categoriaId null (no inventes). categoriaNueva solo si el
  usuario pide una categoría nueva. esHormiga true para gastos pequeños y cotidianos (≤ $50.000,
  café, domicilios, transporte por app, snacks), si no null. Si el usuario dice que es "del hogar"
  o "con mi pareja" y hay presupuesto del hogar, pon hogarCategoriaId.
- ingreso: le pagaron, recibió, le llegó plata. tipoIngreso "salario" si es su sueldo/quincena/pago
  del trabajo; "extra" si es otra cosa (venta, regalo, bono).
- pago_obligacion: pagó una deuda o gasto fijo QUE YA EXISTE en el contexto (arriendo, luz,
  tarjeta, cuota del carro…). obligacionId = su id exacto. monto = lo que pagó (si no lo dice, la
  cuota de esa obligación).
- ahorro: ahorró/guardó/metió plata en un bolsillo existente → bolsilloId exacto. Si no dice cuál y
  solo hay uno, usa ese; si hay varios y no se sabe, bolsilloId null.
- crear_bolsillo: quiere empezar a ahorrar para una meta nueva ("quiero ahorrar 2 millones para
  un viaje") → nombre de la meta, monto = la meta.
- crear_categoria: pide crear una categoría de presupuesto → nombre, monto = límite mensual
  (0 si no lo dice), icono del listado.
- crear_deuda: tiene una deuda nueva (préstamo, crédito, tarjeta) que NO está en el contexto →
  monto = saldo total, cuota, diaPago, tasaMensual si la dice, esTarjeta si es tarjeta de crédito.
- crear_gasto_fijo: un pago recurrente nuevo que NO está en el contexto (arriendo, internet,
  gimnasio, suscripción) → monto, diaPago, frecuencia.
- me_deben: le prestó plata a alguien → persona, monto, fechaCompromiso si dice cuándo le pagan.
- abono_me_deben: alguien que le debe le pagó (y está en "Me deben") → meDebenId exacto, monto.
- sin_destino: hay un valor pero no se entiende a qué corresponde → nombre con lo poco que se
  entienda (o vacío) y el monto. El usuario elegirá a dónde va.
- Montos en pesos colombianos como número entero: "20 mil"/"20 lucas" = 20000, "una luca" = 1000,
  "medio millón"/"500 barras" = 500000, "2 millones"/"2 palos"/"2 melones" = 2000000,
  "1.5 millones"/"millón y medio" = 1500000.
- Usa SOLO ids que aparezcan en el contexto. Nunca inventes un id.
- Una acción por cada movimiento distinto. Si no hay nada que registrar, "acciones" = [].
`.trim()

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const parecido = (a: string, b: string) => {
  const x = norm(a), y = norm(b)
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x))
}
const uid = () => Math.random().toString(36).slice(2, 10)
const num = (v: unknown) => {
  let n: number
  if (typeof v === 'string') {
    const t = v.replace(/[^\d.,-]/g, '')
    // "5.000" / "1.250.000" / "5,000" son miles (formato colombiano); "1,85" / "1.85" decimales
    n = /^-?\d{1,3}([.,]\d{3})+$/.test(t) ? Number(t.replace(/[.,]/g, '')) : Number(t.replace(',', '.'))
  } else n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numONull = (v: unknown) => v == null || v === '' ? null : (Number.isFinite(num(v)) && num(v) !== 0 ? num(v) : null)

const NOMBRE_POR_DEFECTO: Record<TipoAccion, string> = {
  gasto: 'Gasto', ingreso: 'Ingreso', pago_obligacion: 'Pago', ahorro: 'Ahorro', crear_categoria: 'Nueva categoría',
  crear_deuda: 'Deuda', crear_gasto_fijo: 'Gasto fijo', crear_bolsillo: 'Meta de ahorro', me_deben: 'Préstamo',
  abono_me_deben: 'Abono', sin_destino: '',
}

export function normalizarAcciones(raw: unknown, ctx: ContextoIA): Accion[] {
  if (!Array.isArray(raw)) return []
  const out: Accion[] = []
  for (const item of raw.slice(0, 15)) {
    if (!item || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const tipo = (TIPOS_ACCION as readonly string[]).includes(String(a.tipo)) ? a.tipo as TipoAccion : 'sin_destino'
    const monto = Math.round(Math.abs(num(a.monto)))
    if (monto <= 0 && tipo !== 'crear_categoria') continue
    const nombre = String(a.nombre ?? '').trim().slice(0, 80) || NOMBRE_POR_DEFECTO[tipo]
    const acc: Accion = { id: uid(), tipo, nombre, monto, faltan: [] }

    switch (tipo) {
      case 'gasto': {
        let categoriaId = ctx.categorias.some(c => c.id === a.categoriaId) ? String(a.categoriaId) : null
        let categoriaNueva = typeof a.categoriaNueva === 'string' && a.categoriaNueva.trim() ? a.categoriaNueva.trim().slice(0, 40) : null
        // "Categoría nueva" que en realidad ya existe → usar la existente
        if (categoriaNueva) {
          const existente = ctx.categorias.find(c => norm(c.nombre) === norm(categoriaNueva!))
          if (existente) { categoriaId = existente.id; categoriaNueva = null }
        }
        acc.categoriaId = categoriaNueva ? null : categoriaId
        acc.categoriaNueva = categoriaNueva
        acc.esHormiga = typeof a.esHormiga === 'boolean' ? a.esHormiga : null
        acc.hogarCategoriaId = ctx.hogar?.categorias.some(c => c.id === a.hogarCategoriaId) ? String(a.hogarCategoriaId) : null
        break
      }
      case 'ingreso': {
        const t = a.tipoIngreso === 'salario' || a.tipoIngreso === 'extra' ? a.tipoIngreso : null
        // Antes se comparaba con el sueldo del MES: una quincena normal quedaba
        // como "extra". Ahora con cada monto de sueldo (cada quincena o el mes).
        // Con ingresos variables, lo que le entra por su trabajo es su ingreso principal.
        const esSueldo = ctx.usuario.montosSueldo.some(base => base > 0 && Math.abs(monto - base) <= base * 0.1)
        acc.tipoIngreso = t ?? (ctx.usuario.tipoIngreso === 'variable' || esSueldo ? 'salario' : 'extra')
        break
      }
      case 'pago_obligacion': {
        const id = String(a.obligacionId ?? '')
        let deuda = ctx.deudas.find(d => d.id === id)
        let fijo = ctx.fijos.find(f => f.id === id)
        if (!deuda && !fijo) {
          // Ubicar por nombre ("pagué el arriendo" → gasto fijo "Arriendo")
          deuda = ctx.deudas.find(d => parecido(d.nombre, nombre))
          fijo = deuda ? undefined : ctx.fijos.find(f => parecido(f.nombre, nombre))
        }
        acc.obligacionId = deuda?.id ?? fijo?.id ?? null
        acc.obligacionTipo = deuda ? 'deuda' : fijo ? 'fijo' : null
        if (!acc.obligacionId) acc.faltan.push('obligacion')
        break
      }
      case 'ahorro': {
        let b = ctx.bolsillos.find(x => x.id === a.bolsilloId) ?? ctx.bolsillos.find(x => parecido(x.nombre, nombre))
        if (!b && ctx.bolsillos.length === 1) b = ctx.bolsillos[0]
        acc.bolsilloId = b?.id ?? null
        if (!acc.bolsilloId) acc.faltan.push('bolsillo')
        break
      }
      case 'crear_categoria': {
        acc.icono = (ICONOS_CATEGORIA as readonly string[]).includes(String(a.icono)) ? String(a.icono) : 'more'
        // Ya existe una con ese nombre: no duplicar
        if (ctx.categorias.some(c => norm(c.nombre) === norm(nombre))) continue
        break
      }
      case 'crear_deuda': {
        acc.cuota = numONull(a.cuota)
        acc.diaPago = clampDia(a.diaPago)
        acc.tasaMensual = numONull(a.tasaMensual)
        acc.esTarjeta = a.esTarjeta === true
        acc.frecuencia = a.frecuencia === 'quincenal' ? 'quincenal' : 'mensual'
        if (!acc.cuota) acc.faltan.push('cuota')
        break
      }
      case 'crear_gasto_fijo': {
        acc.diaPago = clampDia(a.diaPago)
        acc.frecuencia = ['mensual', 'quincenal', 'semanal', 'anual'].includes(String(a.frecuencia)) ? a.frecuencia as Accion['frecuencia'] : 'mensual'
        break
      }
      case 'me_deben': {
        acc.persona = typeof a.persona === 'string' && a.persona.trim() ? a.persona.trim().slice(0, 60) : null
        acc.fechaCompromiso = typeof a.fechaCompromiso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.fechaCompromiso) ? a.fechaCompromiso : null
        if (!acc.persona) acc.faltan.push('persona')
        break
      }
      case 'abono_me_deben': {
        const l = ctx.meDeben.find(x => x.id === a.meDebenId)
          ?? ctx.meDeben.find(x => typeof a.persona === 'string' && parecido(x.persona, a.persona))
          ?? ctx.meDeben.find(x => parecido(x.persona, nombre))
        acc.meDebenId = l?.id ?? null
        acc.persona = l?.persona ?? (typeof a.persona === 'string' ? a.persona : null)
        if (!acc.meDebenId) acc.faltan.push('me_deben')
        break
      }
      case 'sin_destino':
        acc.faltan.push('destino')
        break
    }
    out.push(acc)
  }
  return out
}

function clampDia(v: unknown): number | null {
  const n = Math.round(num(v))
  return n >= 1 && n <= 31 ? n : null
}
