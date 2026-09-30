/**
 * Prueba de punta a punta de Kiri Coach / dictado / escáner SIN gastar cuota
 * de Google: monta solo las rutas /api/ai en un puerto aparte (sin crons) y
 * apunta GEMINI_API_BASE a un Gemini simulado que devuelve respuestas fijas y
 * guarda lo que recibió (para revisar que el prompt lleve los datos reales).
 *
 * Requiere el backend normal corriendo en :4000 (para sembrar datos con la
 * API). Crea un usuario temporal y lo borra al final.
 *   npx tsx scripts/e2e-ia.test.ts
 */
import http from 'node:http'
import 'dotenv/config'

const MOCK_PORT = 4199
const APP_PORT = 4198
process.env.GEMINI_API_BASE = `http://127.0.0.1:${MOCK_PORT}`
process.env.GEMINI_API_KEY = 'clave-de-prueba'

type Resp = { status?: number; body: unknown }
let siguiente: Resp | Resp[] = { body: {} }
let ultimaUrl = ''
let ultimo: { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> } | null = null
const mock = http.createServer((req, res) => {
  let data = ''
  req.on('data', c => { data += c })
  req.on('end', () => {
    ultimo = JSON.parse(data)
    ultimaUrl = req.url ?? ''
    const r = Array.isArray(siguiente) ? (siguiente.shift() ?? { body: {} }) : siguiente
    res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(r.status && r.status >= 400 ? JSON.stringify(r.body) : JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(r.body) }] } }] }))
  })
})

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const aiRoutes = (await import('../src/routes/ai.routes.js')).default

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/ai', aiRoutes)
  const server = app.listen(APP_PORT)
  mock.listen(MOCK_PORT)

  const stamp = Date.now()
  const u = await prisma.user.create({ data: { nombre: 'Sofía Coach', correo: `sofia-ia-${stamp}@local.test`, username: `sofiaia${stamp}`, passwordHash: 'x', onboardingDone: true, ingresoBase: 3000000, frecuenciaIngreso: 'quincenal', cashBalance: 3000000, walletLibre: 3000000 } })
  const token = jwt.sign({ userId: u.id, correo: 'qa.me@kiri.test' }, process.env.JWT_SECRET!, { expiresIn: '1h' })
  const api = async (base: string, method: string, path: string, body?: unknown, t: string | null = token) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, ...(await r.json().catch(() => ({}))) } as Record<string, any>
  }
  const main4000 = (m: string, p: string, b?: unknown) => api('http://localhost:4000/api', m, p, b)
  const ia = (m: string, p: string, b?: unknown, t: string | null = token) => api(`http://127.0.0.1:${APP_PORT}/api/ai`, m, p, b, t)

  try {
    // ── Datos reales del usuario ──
    const comida = (await main4000('POST', '/budget-categories', { nombre: 'Comida', montoLimite: 600000, icono: 'utensils' })).category
    const transporte = (await main4000('POST', '/budget-categories', { nombre: 'Transporte', montoLimite: 200000, icono: 'car' })).category
    const tarjeta = (await main4000('POST', '/debts', { nombre: 'Tarjeta Visa', montoTotal: 2000000, cuotaPeriodo: 150000, tasaInteres: 2.1, diasPago: '5', tipoDeuda: 'TARJETA_CREDITO' })).debt
    const arriendo = (await main4000('POST', '/fixed-expenses', { nombre: 'Arriendo', monto: 900000, fechaCorte: '2026-10-01' })).fixedExpense
    const viaje = (await main4000('POST', '/savings-pockets', { nombre: 'Viaje a Cartagena', meta: 3000000 })).pocket
    const juan = (await main4000('POST', '/external-loans', { persona: 'Juan Pérez', monto: 80000, salioDeBilletera: false })).loan
    await main4000('POST', '/impulse-expenses', { nombre: 'Almuerzo corrientazo', monto: 16000, categoria: 'otro', budgetCategoryId: comida?.id, descontarBilletera: true })
    check('Datos de prueba creados', comida?.id && transporte?.id && tarjeta?.id && arriendo?.id && viaje?.id && juan?.id,
      { comida: !!comida?.id, transporte: !!transporte?.id, tarjeta: !!tarjeta?.id, arriendo: !!arriendo?.id, viaje: !!viaje?.id, juan: !!juan?.id })

    const estado = await ia('GET', '/estado')
    check('GET /ai/estado: activa con clave', estado.activa === true)
    const sinLogin = await ia('POST', '/coach', { mensaje: 'hola' }, null)
    check('Sin login no se puede usar la IA (antes las rutas eran públicas)', sinLogin.status === 401)

    // ── Coach ──
    siguiente = { body: {
      respuesta: 'Te dejé listo el registro abajo: revísalo y confírmalo.',
      acciones: [
        { tipo: 'gasto', nombre: 'Almuerzo', monto: 18000, categoriaId: comida.id, esHormiga: true },
        { tipo: 'pago_obligacion', nombre: 'arriendo', monto: 900000, obligacionId: 'id-inventado' },
        { tipo: 'ahorro', nombre: 'para el viaje', monto: 100000, bolsilloId: null },
        { tipo: 'gasto', nombre: 'Cosa rara', monto: '5.000', categoriaId: 'categoria-que-no-existe' },
        { tipo: 'gasto', nombre: 'Monto cero', monto: 0 },
      ],
      sugerencias: ['¿Cómo voy este mes?', '¿Qué deuda pago primero?', 'x', 'y'],
      ir: { ruta: '/obligaciones', etiqueta: 'Ver obligaciones' },
    } }
    const c = await ia('POST', '/coach', { mensaje: 'Registra un almuerzo de 18 mil, pagué el arriendo y ahorré 100 mil', historial: [{ rol: 'usuario', texto: 'hola' }, { rol: 'coach', texto: '¡Hola Sofía!' }], pantalla: 'Gestión › Proyecciones' })
    const sis = ultimo?.systemInstruction?.parts[0].text ?? ''
    check('El coach recibe el MANUAL completo de la app', sis.includes('KIRI FINANCE — MANUAL COMPLETO') && sis.includes('Presupuesto del hogar') && sis.includes('Proyecciones'))
    check('…y los datos REALES con ids (categorías, deudas, fijos, bolsillos, me deben)', [comida.id, tarjeta.id, arriendo.id, viaje.id, juan.id].every(id => sis.includes(id)))
    check('…el historial real (sin números al azar) y los últimos movimientos', sis.includes('HISTORIAL REAL') && sis.includes('Almuerzo corrientazo') && sis.includes('-$16.000'))
    check('…la tasa de la tarjeta como mensual y la pantalla actual', sis.includes('2.1%') && sis.includes('Gestión › Proyecciones'))
    check('La conversación previa va como turnos (usuario/modelo)', ultimo?.contents.length === 3 && ultimo.contents[1].role === 'model' && ultimo.contents[2].role === 'user')
    check('Pide JSON con esquema', ultimo?.generationConfig.responseMimeType === 'application/json' && !!ultimo?.generationConfig.responseSchema)
    const [g1, pago, ahorro, rara] = c.acciones ?? []
    check('Respuesta del coach con sugerencias (máx. 3) e "ir"', c.status === 200 && c.respuesta.includes('confírmalo') && c.sugerencias.length === 3 && c.ir?.ruta === '/obligaciones')
    check('Gasto con categoría real se conserva', g1?.tipo === 'gasto' && g1.categoriaId === comida.id && g1.esHormiga === true && g1.faltan.length === 0)
    check('Pago con id inventado se ubica por nombre → gasto fijo Arriendo', pago?.obligacionId === arriendo.id && pago.obligacionTipo === 'fijo' && pago.faltan.length === 0, pago)
    check('Ahorro sin bolsillo → el único bolsillo (Viaje a Cartagena)', ahorro?.bolsilloId === viaje.id)
    check('Categoría inexistente se descarta (no se inventan ids) y "5.000" → 5000', rara?.categoriaId === null && rara.monto === 5000)
    check('Acciones con monto 0 se descartan', c.acciones.length === 4)

    // ── Dictado ──
    siguiente = { body: {
      resumen: 'Entendí varias cosas.', confianza: 'alta',
      acciones: [
        { tipo: 'ingreso', nombre: 'Quincena', monto: 1500000 },
        { tipo: 'ingreso', nombre: 'Venta de ropa', monto: 120000 },
        { tipo: 'me_deben', nombre: 'Préstamo', monto: 50000 },
        { tipo: 'abono_me_deben', nombre: 'Abono', monto: 30000, persona: 'juan' },
        { tipo: 'crear_deuda', nombre: 'Crédito moto', monto: 5000000 },
        { tipo: 'crear_categoria', nombre: 'comida', monto: 100000 },
        { tipo: 'crear_categoria', nombre: 'Mascotas', monto: 150000, icono: 'paw' },
        { tipo: 'gasto', nombre: 'Taxi', monto: 12000, categoriaNueva: 'transporte' },
        { tipo: 'pago_obligacion', nombre: 'algo que no existe', monto: 70000 },
        { tipo: 'nada', nombre: '??', monto: 9000 },
      ],
    } }
    const d = await ia('POST', '/dictado', { transcripcion: 'me pagaron la quincena, vendí ropa en 120 lucas, le presté 50 mil a alguien...' })
    const a = d.acciones as any[]
    const por = (t: string, n?: string) => a.find(x => x.tipo === t && (!n || x.nombre === n))
    check('Dictado: el prompt lleva la transcripción', JSON.stringify(ultimo?.contents).includes('vendí ropa en 120 lucas'))
    check('Ingreso igual a su quincena ($3M al mes / 2) → salario; otro → extra', por('ingreso', 'Quincena')?.tipoIngreso === 'salario' && por('ingreso', 'Venta de ropa')?.tipoIngreso === 'extra')
    check('Me deben sin persona → pide completar "persona"', por('me_deben')?.faltan.includes('persona'))
    check('Abono de "juan" → se ubica el Me deben de Juan Pérez', por('abono_me_deben')?.meDebenId === juan.id && por('abono_me_deben')?.faltan.length === 0)
    check('Deuda nueva sin cuota → pide completar "cuota"', por('crear_deuda')?.faltan.includes('cuota'))
    check('No duplica una categoría que ya existe (comida) y sí crea Mascotas', !a.some(x => x.tipo === 'crear_categoria' && x.nombre === 'comida') && por('crear_categoria', 'Mascotas')?.icono === 'paw')
    check('"Categoría nueva" que ya existe (transporte) → usa la existente', por('gasto', 'Taxi')?.categoriaId === transporte.id && por('gasto', 'Taxi')?.categoriaNueva === null)
    check('Pago de algo que no existe → el usuario elige la obligación', por('pago_obligacion')?.obligacionId === null && por('pago_obligacion')?.faltan.includes('obligacion'))
    check('Tipo desconocido → sin destino (el usuario elige a dónde va)', por('sin_destino')?.faltan.includes('destino') && por('sin_destino')?.monto === 9000)

    // ── Recibo ──
    const img = Buffer.from('x'.repeat(400)).toString('base64')
    siguiente = { body: { esRecibo: true, establecimiento: '', fecha: '2026-09-20', total: 45600, items: [{ descripcion: 'Producto', monto: 45600 }, { descripcion: '', monto: 10 }], nombreClaro: false, confianza: 'media', acciones: [] } }
    const rc = await ia('POST', '/recibo', { imageBase64: img, mimeType: 'image/jpeg' })
    check('Recibo: la imagen va a la IA como inlineData', JSON.stringify(ultimo?.contents).includes('"inlineData"'))
    check('Recibo con valor pero sin nombre claro → "sin destino" con el total para que el usuario elija', rc.total === 45600 && rc.acciones.length === 1 && rc.acciones[0].tipo === 'sin_destino' && rc.acciones[0].monto === 45600 && rc.acciones[0].nombre === '' && rc.nombreClaro === false)
    check('Ítems vacíos se filtran', rc.items.length === 1)
    siguiente = { body: { esRecibo: true, establecimiento: 'Enel Codensa', total: 132000, items: [], nombreClaro: true, confianza: 'alta', acciones: [{ tipo: 'pago_obligacion', nombre: 'Luz', monto: 132000, obligacionId: arriendo.id }] } }
    const rc2 = await ia('POST', '/recibo', { imageBase64: img, mimeType: 'image/png' })
    check('Recibo de servicio que coincide con un gasto fijo → pago de esa obligación', rc2.acciones[0]?.tipo === 'pago_obligacion' && rc2.acciones[0].obligacionTipo === 'fijo')
    const malo = await ia('POST', '/recibo', { imageBase64: img, mimeType: 'application/pdf' })
    check('Solo acepta imágenes', malo.status === 400)

    // ── Errores de la IA → mensajes claros ──
    siguiente = { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } }
    const e1 = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Clave inválida → "La IA de Kiri todavía no está activada"', e1.status === 503 && e1.codigo === 'clave_invalida' && e1.error.includes('todavía no está activada'))
    siguiente = { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }
    const e2 = await ia('POST', '/dictado', { transcripcion: 'hola' })
    check('Cuota agotada → 429 "límite de uso"', e2.status === 429 && e2.codigo === 'limite')
    siguiente = { body: 'esto no es json' as unknown }
    const e3 = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Respuesta no-JSON de la IA → error claro, no se rompe', e3.status === 503 && e3.codigo === 'respuesta_invalida')
    siguiente = [
      { status: 404, body: { error: { code: 404, message: 'This model is no longer available', status: 'NOT_FOUND' } } },
      { body: { respuesta: 'Hola desde el respaldo', acciones: [], sugerencias: [] } },
    ]
    const e5 = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Modelo retirado (404) → reintenta con el primer respaldo (gemini-3.5-flash)', e5.status === 200 && e5.respuesta === 'Hola desde el respaldo' && ultimaUrl.includes('/gemini-3.5-flash:'), ultimaUrl)
    siguiente = [
      { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } },
      { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } },
      { body: { respuesta: 'Respondió el respaldo', acciones: [], sugerencias: [] } },
    ]
    const e6 = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Modelo saturado (503 ×2) → sigue la cadena hasta gemini-flash-lite-latest', e6.status === 200 && e6.respuesta === 'Respondió el respaldo' && ultimaUrl.includes('gemini-flash-lite-latest'), ultimaUrl)
    siguiente = [
      { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } },
      { body: { respuesta: 'Cuota de otro modelo', acciones: [], sugerencias: [] } },
    ]
    const e6b = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Cuota agotada solo en el principal (429) → responde el respaldo', e6b.status === 200 && e6b.respuesta === 'Cuota de otro modelo')
    siguiente = { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE' } } }
    const e7 = await ia('POST', '/coach', { mensaje: 'hola' })
    check('Todo saturado → mensaje "mucha demanda"', e7.status === 503 && e7.codigo === 'saturada')
    const vacio = await ia('POST', '/coach', { mensaje: '   ' })
    check('Mensaje vacío → 400', vacio.status === 400)
    const guardaKey = { g: process.env.GEMINI_API_KEY, gg: process.env.GOOGLE_GENAI_API_KEY, ga: process.env.GOOGLE_API_KEY }
    delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_GENAI_API_KEY; delete process.env.GOOGLE_API_KEY
    const e4 = await ia('POST', '/coach', { mensaje: 'hola' })
    const est2 = await ia('GET', '/estado')
    check('Sin clave → no_configurada y /estado activa=false', e4.codigo === 'no_configurada' && est2.activa === false)
    process.env.GEMINI_API_KEY = guardaKey.g
  } catch (e) {
    console.error('ERROR', e)
    results.push(false)
  } finally {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {})
    await prisma.$disconnect()
    server.close(); mock.close()
    console.log(`\n${results.filter(Boolean).length}/${results.length} OK — usuario temporal eliminado`)
    process.exit(0)
  }
}
main()
