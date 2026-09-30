/**
 * Lista los mensajes del backend que el usuario ve (errores de la API,
 * avisos, push, notificaciones) y que aún no tienen traducción en
 * src/lib/i18n-en.ts. Las plantillas `…${x}…` salen como "…{0}…".
 *   node scripts/i18n-extraer.mjs               → resumen
 *   node scripts/i18n-extraer.mjs --json f.json → escribe los que faltan
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const RAIZ = path.resolve('src')
const CLAVES = new Set(['error', 'message', 'desc', 'title', 'body', 'detalle', 'mensaje', 'descripcion', 'subject', 'texto', 'displayName', 'motivo', 'label', 'reason', 'titulo'])
const EXCLUIR = /^(lib\/ai\/|seeds\/|lib\/i18n)/
const ES = /[a-záéíóúñ]/i

const enSrc = fs.existsSync(path.join(RAIZ, 'lib/i18n-en.ts')) ? fs.readFileSync(path.join(RAIZ, 'lib/i18n-en.ts'), 'utf8') : ''
const EN = new Set()
const enSf = ts.createSourceFile('en.ts', enSrc, ts.ScriptTarget.Latest, true)
const mirar = n => { if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) EN.add(n.name.text); ts.forEachChild(n, mirar) }
mirar(enSf)

const listar = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? listar(path.join(d, e.name)) : /\.ts$/.test(e.name) ? [path.join(d, e.name)] : [])
const claves = new Map()
const agregar = (k, f) => { k = k.trim(); if (!k || !ES.test(k.replace(/\{\d+\}/g, '')) || !/\s|[áéíóúñ¿¡]|^[A-ZÁÉÍÓÚ]/.test(k)) return; if (!claves.has(k)) claves.set(k, new Set()); claves.get(k).add(f) }
const textoDe = n => {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) { let k = n.head.text; n.templateSpans.forEach((s, i) => { k += `{${i}}` + s.literal.text }); return k }
  return null
}
// Literales que llegan a un campo visible (subiendo por ternarios, ||, ??, +)
const hojas = n => {
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n)) return hojas(n.expression)
  if (ts.isConditionalExpression(n)) return [...hojas(n.whenTrue), ...hojas(n.whenFalse)]
  if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)) return [...hojas(n.left), ...hojas(n.right)]
  const t = textoDe(n)
  const out = t !== null ? [t] : []
  // Los ${…} de una plantilla pueden ser frases también
  if (ts.isTemplateExpression(n)) n.templateSpans.forEach(s => out.push(...hojas(s.expression)))
  return out
}
for (const f of listar(RAIZ)) {
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/')
  if (EXCLUIR.test(rel)) continue
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
  const v = n => {
    if (ts.isPropertyAssignment(n) && CLAVES.has(n.name.getText(sf).replace(/['"]/g, ''))) hojas(n.initializer).forEach(k => agregar(k, rel))
    // Variables que guardan el mensaje: const message = `…`, let premio = ` ¡Ganaste…`
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && /^(message|mensaje|msg|texto|titulo|title|body|detalle|premio|mejoraTxt|aviso)/i.test(n.name.text)) hojas(n.initializer).forEach(k => agregar(k, rel))
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && /^(message|mensaje|msg|texto|titulo|title|body|detalle|premio)/i.test(n.left.text)) hojas(n.right).forEach(k => agregar(k, rel))
    // Errores de negocio que llegan al usuario
    if (ts.isNewExpression(n) && /RejectedError|HttpError|AppError/.test(n.expression.getText(sf))) (n.arguments ?? []).forEach(a => hojas(a).forEach(k => agregar(k, rel)))
    ts.forEachChild(n, v)
  }
  v(sf)
}
const faltan = [...claves.keys()].filter(k => !EN.has(k))
console.log(`Mensajes: ${claves.size} · traducidos: ${claves.size - faltan.length} · faltan: ${faltan.length}`)
const i = process.argv.indexOf('--json')
if (i > 0) { const o = {}; for (const k of faltan) o[k] = [...claves.get(k)]; fs.writeFileSync(process.argv[i + 1], JSON.stringify(o, null, 1)); console.log('Escrito', process.argv[i + 1]) }
