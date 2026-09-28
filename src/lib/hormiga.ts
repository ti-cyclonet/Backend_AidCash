/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Clasificación automática de gasto hormiga
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Un gasto hormiga es un gasto chico y cotidiano que, sumado, se come el
 * disponible sin que se note. Se marca solo si el monto es pequeño o si el
 * nombre calza con un consumo típico de ese tipo (transporte por app, café,
 * domicilios, antojos…). Es solo el valor por defecto: el usuario lo puede
 * cambiar desde el frontend. La misma regla vive en
 * Frontend_AidCash/src/lib/hormiga.ts para mostrar la sugerencia al registrar
 * — si se cambia una, cambiar la otra.
 */

/** Monto (COP) hasta el cual un gasto se considera hormiga por sí solo. */
export const HORMIGA_MONTO_MAX = 50_000

export const HORMIGA_KEYWORDS: string[] = [
  // café
  'café', 'cafe', 'starbucks', 'tinto', 'capuchino', 'latte', 'espresso', 'juan valdez',
  // comida rápida / domicilios
  'almuerzo', 'desayuno', 'hamburguesa', 'pizza', 'empanada', 'arepa', 'sandwich', 'perro', 'perrito',
  'buñuelo', 'domicilio', 'rappi', 'ifood', 'uber eats', 'didi food', 'snack', 'helado', 'postre', 'comida rapida',
  // transporte por app / taxis
  'uber', 'indriver', 'in driver', 'didi', 'cabify', 'picap', 'taxi', 'bus', 'transmilenio', 'metro', 'pasaje',
  'parqueadero', 'peaje',
  // antojos
  'dulce', 'chocolate', 'galleta', 'chicle', 'golosina', 'antojo', 'vending', 'papas', 'gaseosa', 'jugo',
  // salidas
  'cerveza', 'trago', 'cover', 'boleta', 'cine',
  // otros pequeños
  'propina', 'fotocopia', 'impresion', 'recarga',
]

function normalizar(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Solo frontera al INICIO de la palabra: "perritos" calza con "perrito", pero
// "combustible" no calza con "bus".
const KEYWORD_REGEXES = HORMIGA_KEYWORDS
  .map(normalizar)
  .map(k => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

export function esGastoHormiga(nombre: string, monto: number): boolean {
  if (monto > 0 && monto <= HORMIGA_MONTO_MAX) return true
  const n = normalizar(nombre)
  return KEYWORD_REGEXES.some(r => r.test(n))
}

/**
 * Nombre "limpio" para agrupar: sin la etiqueta de categoría de Presupuesto
 * (que según el formulario va al inicio "[Cat] X" o al final "X [Cat]"), sin
 * el 🐜 legacy y sin diferencias de mayúsculas/espacios — así "InDriver",
 * "InDriver [Transporte]" y "indriver " cuentan como el mismo consumo.
 */
export function nombreBaseGasto(nombre: string): string {
  return nombre
    .replace(/^🐜\s*/u, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\s*\[[^\]]*\]$/, '')
    .replace(/\s*\(gasto fijo\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}
