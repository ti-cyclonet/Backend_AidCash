/**
 * Auditoría QA "usuario cruel": montos absurdos, textos gigantes, ids ajenos
 * (IDOR), JSON roto, doble clic concurrente y escalada de plan. Monta todas las
 * rutas en un puerto aparte (sin crons ni límite global de peticiones), con dos
 * usuarios temporales que se borran al final.
 *   npx tsx scripts/e2e-qa-abuso.test.ts
 */
import 'dotenv/config'

const APP_PORT = 4187
process.env.AUTHORIZA_API_URL = 'http://127.0.0.1:1' // Authoriza "caído": nada sale de la máquina

const results: boolean[] = []
const check = (name: string, cond: unknown, extra: unknown = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== '' ? '  → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 220) : ''}`) }

async function main() {
  const { prisma } = await import('../src/config/database.js')
  const jwt = (await import('jsonwebtoken')).default
  const express = (await import('express')).default
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { traducirRespuestas } = await import('../src/lib/i18n.js')
  const r = async (m: string) => (await import(`../src/routes/${m}.routes.js`)).default
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use(traducirRespuestas)
  const montajes: [string, string][] = [
    ['auth', 'auth'], ['users', 'user'], ['debts', 'debts'], ['fixed-expenses', 'fixed-expenses'], ['savings', 'savings'],
    ['extra-incomes', 'extra-incomes'], ['impulse-expenses', 'impulse'], ['emergency-fund', 'emergency-fund'],
    ['gamification', 'gamification'], ['missions', 'missions'], ['reports', 'reports'], ['connections', 'connections'],
    ['external-loans', 'external-loans'], ['notifications', 'notifications'], ['savings-pockets', 'savings-pockets'],
    ['budget-categories', 'budget-categories'], ['projections', 'projections'], ['plan', 'plan'], ['usage-status', 'usage-status'],
  ]
  for (const [ruta, mod] of montajes) app.use(`/api/${ruta}`, await r(mod))
  app.use(errorHandler)
  const server = app.listen(APP_PORT)

  const stamp = Date.now()
  const ids: string[] = []
  const crear = async (nombre: string) => {
    const correo = `${nombre.toLowerCase()}-${stamp}@abuso.test`
    const u = await prisma.user.create({ data: { nombre, correo, username: `${nombre.toLowerCase()}${stamp}`.slice(0, 20), passwordHash: 'x', onboardingDone: true, ingresoBase: 3000000, frecuenciaIngreso: 'mensual', diasPago: [30], cashBalance: 2000000, walletLibre: 2000000 } })
    ids.push(u.id)
    return { ...u, token: jwt.sign({ userId: u.id, correo }, process.env.JWT_SECRET!, { expiresIn: '1h' }) }
  }
  const call = async (u: { token: string } | null, method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: `Bearer ${u.token}` } : {}) }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) })
    const txt = await res.text()
    let j: any = {}
    try { j = JSON.parse(txt) } catch { j = { _texto: txt.slice(0, 120) } }
    return { status: res.status, ...(Array.isArray(j) ? { lista: j } : j) } as Record<string, any>
  }
  const no500 = (x: { status: number }) => x.status < 500

  try {
    const A = await crear('Ana')
    const B = await crear('Beto')

    // ── Sin sesión ──
    for (const p of ['/debts', '/fixed-expenses', '/impulse-expenses', '/savings-pockets', '/external-loans', '/users/wallet', '/budget-categories', '/reports/balance', '/auth/me']) {
      const x = await call(null, 'GET', p)
      check(`Sin token ${p} → 401`, x.status === 401, x.status)
    }
    const tokenFalso = await call({ token: jwt.sign({ userId: A.id, correo: A.correo }, 'otra-clave') }, 'GET', '/debts')
    check('Token firmado con otra clave → 401', tokenFalso.status === 401)
    const usuarioBorrado = await call({ token: jwt.sign({ userId: '00000000-0000-0000-0000-000000000000', correo: 'x@x.co' }, process.env.JWT_SECRET!) }, 'GET', '/debts')
    check('Token de un usuario que no existe → 401', usuarioBorrado.status === 401)

    // ── JSON roto / tipos equivocados ──
    const roto = await call(A, 'POST', '/impulse-expenses', undefined, '{"nombre": "café", monto: }')
    check('JSON mal formado → 400 (no 500)', roto.status === 400, roto)
    const montoTexto = await call(A, 'POST', '/impulse-expenses', { nombre: 'café', monto: '5000' })
    check('Monto como texto → 400', montoTexto.status === 400)
    const sinCuerpo = await call(A, 'POST', '/debts', undefined)
    check('POST sin cuerpo → 400', sinCuerpo.status === 400, sinCuerpo.status)

    // ── Montos absurdos ──
    const neg = await call(A, 'POST', '/impulse-expenses', { nombre: 'negativo', monto: -5000 })
    check('Gasto negativo → 400', neg.status === 400)
    const cero = await call(A, 'POST', '/impulse-expenses', { nombre: 'cero', monto: 0, descontarBilletera: true })
    check('Gasto de $0 → rechazado', cero.status === 400, cero.status)
    const gigante = await call(A, 'POST', '/impulse-expenses', { nombre: 'yate', monto: 1e13, descontarBilletera: true })
    check('Gasto de 10 billones (supera la columna) → 400 claro, no 500', gigante.status === 400, gigante)
    const debtGig = await call(A, 'POST', '/debts', { nombre: 'Hipoteca Luna', montoTotal: 5e12, cuotaPeriodo: 1e6 })
    check('Deuda de 5 billones → 400, no 500', debtGig.status === 400, debtGig)
    const tasa = await call(A, 'POST', '/debts', { nombre: 'Gota a gota', montoTotal: 1000000, cuotaPeriodo: 100000, tasaInteres: 1500 })
    check('Tasa de interés 1500% (columna 5,2) → 400, no 500', tasa.status === 400, tasa)
    const ingresoGig = await call(A, 'POST', '/users/wallet/income', { monto: 9e11, tipo: 'extra' })
    check('Ingreso a billetera de 900 mil millones → 400, no 500', ingresoGig.status === 400, ingresoGig)
    const perfilGig = await call(A, 'PATCH', '/users/profile', { ingresoBase: 1e14 })
    check('Sueldo de 100 billones en el perfil → 400, no 500', perfilGig.status === 400, perfilGig)
    const bolsGig = await call(A, 'POST', '/savings-pockets', { nombre: 'Luna', meta: 1e15 })
    check('Meta de bolsillo 1e15 → 400, no 500', bolsGig.status === 400, bolsGig)
    const catGig = await call(A, 'POST', '/budget-categories', { nombre: 'Todo', montoLimite: 1e15 })
    check('Límite de categoría 1e15 → 400, no 500', catGig.status === 400, catGig)
    const decimales = await call(A, 'POST', '/impulse-expenses', { nombre: 'centavos', monto: 1234.5678, descontarBilletera: true })
    check('Monto con 4 decimales → no rompe', no500(decimales), decimales.status)

    // ── Textos ──
    const vacio = await call(A, 'POST', '/impulse-expenses', { nombre: '     ', monto: 1000 })
    check('Nombre solo con espacios → 400', vacio.status === 400, vacio.status)
    const largo = await call(A, 'POST', '/impulse-expenses', { nombre: 'x'.repeat(200_000), monto: 1000 })
    check('Nombre de 200.000 caracteres → 400', largo.status === 400, largo.status)
    const largoDeuda = await call(A, 'POST', '/debts', { nombre: 'y'.repeat(50_000), montoTotal: 1000, cuotaPeriodo: 100 })
    check('Deuda con nombre de 50.000 caracteres → 400', largoDeuda.status === 400, largoDeuda.status)
    const largoFijo = await call(A, 'POST', '/fixed-expenses', { nombre: 'z'.repeat(50_000), monto: 1000, fechaCorte: '5' })
    check('Gasto fijo con nombre de 50.000 caracteres → 400', largoFijo.status === 400, largoFijo.status)
    const largoExtra = await call(A, 'POST', '/extra-incomes', { nombre: 'w'.repeat(50_000), monto: 1000, temporalidad: 'una_vez' })
    check('Ingreso extra con nombre de 50.000 caracteres → 400', largoExtra.status === 400, largoExtra.status)
    const xss = '<img src=x onerror=alert(1)>☕ Café "Juan\'s" 🐜'
    const conXss = await call(A, 'POST', '/impulse-expenses', { nombre: xss, monto: 4500, descontarBilletera: true })
    check('Nombre con HTML/emoji/comillas se guarda tal cual (React lo escapa)', conXss.status === 201 && (conXss.expense?.nombre ?? conXss.nombre ?? conXss.impulseExpense?.nombre) === xss, conXss)

    // ── Días/fechas inválidas ──
    const diaMalo = await call(A, 'POST', '/debts', { nombre: 'Día 45', montoTotal: 100000, cuotaPeriodo: 10000, diasPago: '45' })
    check('Deuda con día de pago 45 → 400', diaMalo.status === 400, diaMalo.status)
    const diaTexto = await call(A, 'POST', '/debts', { nombre: 'Día abc', montoTotal: 100000, cuotaPeriodo: 10000, diasPago: 'abc' })
    check('Deuda con día de pago "abc" → 400', diaTexto.status === 400, diaTexto.status)
    const corteMalo = await call(A, 'POST', '/fixed-expenses', { nombre: 'Corte raro', monto: 50000, fechaCorte: 'mañana' })
    check('Gasto fijo con fecha de corte "mañana" → 400', corteMalo.status === 400, corteMalo.status)
    const cuotaMayor = await call(A, 'POST', '/debts', { nombre: 'Cuota > total', montoTotal: 100000, cuotaPeriodo: 500000 })
    check('Cuota mayor que la deuda → no rompe', no500(cuotaMayor), cuotaMayor.status)

    // ── Datos de Ana para intentar tocarlos desde Beto ──
    const deuda = await call(A, 'POST', '/debts', { nombre: 'Moto', montoTotal: 2000000, cuotaPeriodo: 200000, diasPago: '15' })
    const fijo = await call(A, 'POST', '/fixed-expenses', { nombre: 'Arriendo', monto: 900000, fechaCorte: '5' })
    const bolsillo = await call(A, 'POST', '/savings-pockets', { nombre: 'Viaje', meta: 1000000 })
    const cat = await call(A, 'POST', '/budget-categories', { nombre: 'Comida', montoLimite: 400000 })
    const prest = await call(A, 'POST', '/external-loans', { persona: 'Juan', monto: 100000, salioDeBilletera: false })
    const extra = await call(A, 'POST', '/extra-incomes', { nombre: 'Freelance', monto: 300000, temporalidad: 'una_vez' })
    const idDe = (x: Record<string, any>) => x.debt?.id ?? x.fixedExpense?.id ?? x.pocket?.id ?? x.category?.id ?? x.loan?.id ?? x.prestamo?.id ?? x.extraIncome?.id ?? x.income?.id ?? x.expense?.id ?? x.id
    const idDeuda = idDe(deuda), idFijo = idDe(fijo), idBolsillo = idDe(bolsillo), idCat = idDe(cat), idPrest = idDe(prest), idExtra = idDe(extra)
    check('Datos de Ana creados', [idDeuda, idFijo, idBolsillo, idCat, idPrest, idExtra].every(Boolean), { deuda: deuda.status, fijo: fijo.status, bolsillo: bolsillo.status, cat: cat.status, prest: prest.status, extra: extra.status, keys: [Object.keys(deuda), Object.keys(prest), Object.keys(extra)] })

    // ── IDOR: Beto intenta leer/cambiar/borrar/pagar lo de Ana ──
    const intentos: [string, string, unknown?][] = [
      ['PATCH', `/debts/${idDeuda}`, { nombre: 'hackeada' }],
      ['POST', `/debts/${idDeuda}/pay`, { monto: 1000 }],
      ['POST', `/debts/${idDeuda}/undo-pay`, {}],
      ['DELETE', `/debts/${idDeuda}`],
      ['PATCH', `/fixed-expenses/${idFijo}`, { monto: 1 }],
      ['PATCH', `/fixed-expenses/${idFijo}/pay`, {}],
      ['DELETE', `/fixed-expenses/${idFijo}`],
      ['PATCH', `/savings-pockets/${idBolsillo}`, { nombre: 'mío' }],
      ['POST', `/savings-pockets/${idBolsillo}/withdraw`, { monto: 1 }],
      ['POST', `/savings-pockets/${idBolsillo}/deposit`, { monto: 1 }],
      ['DELETE', `/savings-pockets/${idBolsillo}`],
      ['PATCH', `/budget-categories/${idCat}`, { nombre: 'mía' }],
      ['DELETE', `/budget-categories/${idCat}`],
      ['PATCH', `/external-loans/${idPrest}`, { persona: 'Beto' }],
      ['POST', `/external-loans/${idPrest}/abono`, { monto: 1000 }],
      ['POST', `/external-loans/${idPrest}/perdonar`, {}],
      ['DELETE', `/external-loans/${idPrest}`],
      ['PATCH', `/extra-incomes/${idExtra}`, { monto: 1 }],
      ['DELETE', `/extra-incomes/${idExtra}`],
    ]
    for (const [m, p, b] of intentos) {
      const x = await call(B, m, p, b)
      check(`IDOR: Beto ${m} ${p.replace(/[0-9a-f-]{36}/, ':id')} → 403/404`, x.status === 404 || x.status === 403, x.status)
    }
    const deudasBeto = await call(B, 'GET', '/debts')
    check('Beto no ve las deudas de Ana', !JSON.stringify(deudasBeto).includes('Moto'))
    const sigue = await prisma.debt.findUnique({ where: { id: idDeuda } })
    check('La deuda de Ana sigue intacta', sigue?.nombre === 'Moto')
    const idMalo = await call(A, 'PATCH', '/debts/no-es-un-uuid', { nombre: 'x' })
    check('Id que no es UUID → 400/404, no 500', idMalo.status === 400 || idMalo.status === 404, idMalo.status)

    // ── Retirar más de lo que hay ──
    await call(A, 'POST', `/savings-pockets/${idBolsillo}/deposit`, { monto: 50000 })
    const retiroDeMas = await call(A, 'POST', `/savings-pockets/${idBolsillo}/withdraw`, { monto: 999999 })
    check('Retirar del bolsillo más de lo que tiene → 400', retiroDeMas.status === 400, retiroDeMas.status)
    const fondoDeMas = await call(A, 'POST', '/emergency-fund/transaction', { monto: 99999999, tipo: 'retiro' })
    check('Retirar del fondo de emergencia más de lo que hay → 400', fondoDeMas.status === 400, fondoDeMas)
    const abonoDeMas = await call(A, 'POST', `/external-loans/${idPrest}/abono`, { monto: 5000000, entraABilletera: false })
    check('Abono mayor a lo que me deben → 400', abonoDeMas.status === 400, abonoDeMas.status)
    const cashAntesPago = Number((await prisma.user.findUnique({ where: { id: A.id } }))?.cashBalance)
    const pagoDeMas = await call(A, 'POST', `/debts/${idDeuda}/pay`, { monto: 99000000 })
    const cashTrasPago = Number((await prisma.user.findUnique({ where: { id: A.id } }))?.cashBalance)
    check('Pagar $99M a una deuda de $2M → 400 y la billetera no se toca', pagoDeMas.status === 400 && pagoDeMas.maximo === 2000000 && cashAntesPago === cashTrasPago, { status: pagoDeMas.status, maximo: pagoDeMas.maximo, error: pagoDeMas.error, cashAntesPago, cashTrasPago })
    const pagoJusto = await call(A, 'POST', `/debts/${idDeuda}/pay`, { monto: 2000000 })
    check('…pagar exactamente el saldo sí la liquida', pagoJusto.status === 200 && pagoJusto.liquidada === true, pagoJusto.status)
    const ultima = await call(A, 'POST', '/debts', { nombre: 'Última cuota', montoTotal: 300000, saldoRestante: 50000, cuotaPeriodo: 200000, diasPago: '15' })
    const pagoSinMonto = await call(A, 'POST', `/debts/${idDe(ultima)}/pay`, {})
    check('Pagar "la cuota" cuando queda menos que la cuota → paga solo lo que queda', pagoSinMonto.status === 200 && pagoSinMonto.pagado === 50000 && pagoSinMonto.liquidada, { pagado: pagoSinMonto.pagado })

    // ── Doble clic: 5 retiros simultáneos del mismo bolsillo ($50.000, retiro de $40.000 c/u) ──
    const carrera = await Promise.all(Array.from({ length: 5 }, () => call(A, 'POST', `/savings-pockets/${idBolsillo}/withdraw`, { monto: 40000 })))
    const okRetiros = carrera.filter(x => x.status < 300).length
    const bolsilloFinal = await prisma.savingsPocket.findUnique({ where: { id: idBolsillo } })
    check('5 retiros simultáneos: solo 1 pasa y el bolsillo no queda negativo', okRetiros === 1 && Number(bolsilloFinal?.montoActual) >= 0, { okRetiros, saldo: Number(bolsilloFinal?.montoActual) })
    // Fondo de emergencia: 5 aportes de $10.000 a la vez → el fondo sube $50.000 y la billetera baja $50.000
    await prisma.user.update({ where: { id: A.id }, data: { cashBalance: 1000000 } })
    const antesFondo = await prisma.user.findUnique({ where: { id: A.id }, select: { cashBalance: true, fondoEmergenciaActual: true } })
    const aportes = await Promise.all(Array.from({ length: 5 }, () => call(A, 'POST', '/emergency-fund/transaction', { monto: 10000, tipo: 'aporte' })))
    const trasFondo = await prisma.user.findUnique({ where: { id: A.id }, select: { cashBalance: true, fondoEmergenciaActual: true } })
    check('5 aportes simultáneos al fondo: no se pierde plata', aportes.every(a => a.status === 201) && Number(trasFondo!.fondoEmergenciaActual) - Number(antesFondo!.fondoEmergenciaActual) === 50000 && Math.round(Number(antesFondo!.cashBalance) - Number(trasFondo!.cashBalance)) === 50000, { fondo: [Number(antesFondo!.fondoEmergenciaActual), Number(trasFondo!.fondoEmergenciaActual)], cash: [Number(antesFondo!.cashBalance), Number(trasFondo!.cashBalance)] })
    const retirosFondo = await Promise.all(Array.from({ length: 4 }, () => call(A, 'POST', '/emergency-fund/transaction', { monto: 30000, tipo: 'retiro' })))
    const fondoFinal = Number((await prisma.user.findUnique({ where: { id: A.id } }))?.fondoEmergenciaActual)
    check('4 retiros simultáneos de $30.000 de un fondo de $50.000: solo 1 pasa', retirosFondo.filter(x => x.status === 201).length === 1 && fondoFinal === 20000, { ok: retirosFondo.map(x => x.status), fondoFinal })
    // Aportes a un bolsillo con billetera casi vacía: no puede quedar negativa
    await prisma.user.update({ where: { id: B.id }, data: { cashBalance: 30000, walletAhorro: 0 } })
    const bolsB = idDe(await call(B, 'POST', '/savings-pockets', { nombre: 'Moto' }))
    const aportesB = await Promise.all(Array.from({ length: 5 }, () => call(B, 'POST', `/savings-pockets/${bolsB}/deposit`, { monto: 20000 })))
    const cashB = Number((await prisma.user.findUnique({ where: { id: B.id } }))?.cashBalance)
    check('5 aportes simultáneos de $20.000 con $30.000 en la billetera: solo 1 pasa', aportesB.filter(x => x.status === 200).length === 1 && cashB === 10000, { ok: aportesB.map(x => x.status), cashB })

    const cashAntes = Number((await prisma.user.findUnique({ where: { id: A.id } }))?.cashBalance)
    const gastos = await Promise.all(Array.from({ length: 5 }, (_, i) => call(A, 'POST', '/impulse-expenses', { nombre: `rafaga ${i}`, monto: 1000, descontarBilletera: true })))
    const cashDespues = Number((await prisma.user.findUnique({ where: { id: A.id } }))?.cashBalance)
    check('5 gastos simultáneos descuentan exactamente $5.000 de la billetera', gastos.every(g => g.status === 201) && Math.round(cashAntes - cashDespues) === 5000, { antes: cashAntes, despues: cashDespues })

    // ── Escalada de plan cambiando el correo ──
    // (con un correo libre: en la base local qa.me@kiri.test ya existe y el 409 escondía el hueco)
    const esc = await call(B, 'PATCH', '/users/profile', { correo: `libre-${stamp}@abuso.test`, username: `beto${stamp}`.slice(0, 20) })
    const bFinal = await prisma.user.findUnique({ where: { id: B.id } })
    check('Cambiar el correo desde Perfil NO cambia el correo de la cuenta (el resto sí se guarda)', esc.status === 200 && bFinal?.correo === B.correo, { status: esc.status, correo: bFinal?.correo })
    const plan = await call(B, 'GET', '/plan')
    check('…ni regala KIRI PRO', !String(plan.planName ?? plan.plan?.planName ?? '').includes('PRO'), { planName: plan.planName ?? plan.plan?.planName, tier: plan.tier ?? plan.plan?.tier })
    const robo = await call(B, 'PATCH', '/users/profile', { correo: A.correo })
    check('No puede apropiarse del correo de otra persona', (await prisma.user.findUnique({ where: { id: B.id } }))?.correo === B.correo, robo.status)
    const username = await call(B, 'PATCH', '/users/profile', { username: A.username })
    check('Username de otra persona → error claro (no 500)', username.status === 409 || username.status === 400, username)

    // ── Misiones: las acciones reales las cumplen ──
    const { todayPeriodo } = await import('../src/lib/missions.js')
    const mision = (u: { id: string }, key: string, periodo = todayPeriodo()) => prisma.missionProgress.findUnique({ where: { userId_missionKey_periodo: { userId: u.id, missionKey: key, periodo } } })
    const C = await crear('Caro')
    const bolsC = idDe(await call(C, 'POST', '/savings-pockets', { nombre: 'Meta' }))
    await call(C, 'POST', `/savings-pockets/${bolsC}/deposit`, { monto: 1000 })
    check('Aportar a un bolsillo cumple "Haz tu primer aporte de ahorro"', (await mision(C, 'registrar_ahorro', 'onboarding'))?.progress === 1)
    const D = await crear('Dani')
    await call(D, 'POST', '/emergency-fund/transaction', { monto: 1000, tipo: 'aporte' })
    check('Aportar al fondo de emergencia también la cumple', (await mision(D, 'registrar_ahorro', 'onboarding'))?.progress === 1)
    await call(C, 'POST', '/users/wallet/income', { monto: 50000, tipo: 'extra' })
    check('Un ingreso "extra" en la billetera cumple "Registra tu sueldo real"', (await mision(C, 'registrar_ingreso_real', 'onboarding'))?.progress === 1)
    const rafaga = await Promise.all(Array.from({ length: 5 }, (_, i) => call(D, 'POST', '/impulse-expenses', { nombre: `tinto ${i}`, monto: 2000 })))
    const gh = await mision(D, 'gasto_hormiga')
    check('5 gastos a la vez: la misión queda 1/1 (sin choques de llave única)', rafaga.every(r => r.status === 201) && gh?.progress === 1, gh?.progress)
    await call(D, 'POST', '/budget-categories', { nombre: 'Mascotas' })
    check('Crear una categoría cumple "Organiza tus categorías"', (await mision(D, 'categorizar'))?.progress === 1)
    const deudaD = idDe(await call(D, 'POST', '/debts', { nombre: 'Celular', montoTotal: 600000, cuotaPeriodo: 100000 }))
    await call(D, 'POST', `/debts/${deudaD}/pay`, { monto: 50000 })
    check('Abonar a una deuda cumple "Paga o abona una obligación"', (await mision(D, 'pagar_obligacion'))?.progress === 1)

    // ── Perfil ──
    const idiomaMalo = await call(A, 'PATCH', '/users/profile', { idioma: 'fr' })
    check('Idioma no soportado → 400', idiomaMalo.status === 400)
    const dias = await call(A, 'PATCH', '/users/profile', { diasPago: [0, 40] })
    check('Días de pago fuera de 1-31 → 400', dias.status === 400)
  } catch (e) {
    check('Sin excepciones', false, (e as Error).stack)
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
    server.close()
    await prisma.$disconnect()
    const ok = results.filter(Boolean).length
    console.log(`\n${ok}/${results.length} OK`)
    process.exit(ok === results.length ? 0 : 1)
  }
}
main()
