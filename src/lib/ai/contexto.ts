/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Contexto financiero REAL del usuario para la IA
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Antes el coach recibía un historial de 3 meses armado en el navegador con
 * Math.random() ("variaciones simuladas") y ninguna categoría, bolsillo ni
 * obligación con su id: no podía ubicar nada ni dar cifras ciertas. Aquí se
 * arma todo desde la base de datos, con los ids reales que la IA usa para
 * proponer acciones (ver acciones.ts, que valida cada id contra esto).
 */
import { prisma } from '../../config/database.js'
import { resumenCategorias } from '../category-summary.js'
import { cargarContextoDeudas, serializarDeuda } from '../debt-view.js'
import { fixedPeriodo } from '../fixed-expense-payments.js'
import { getMontoPorPeriodo } from '../period.js'
import { resumenHogar } from '../hogar.js'
import { resolverPlan } from '../planes.js'
import { describirIngreso, ingresoPromedioMensual, ingresoReferenciaMensual, montosDeSueldo } from '../ingresos.js'

export interface ContextoIA {
  hoy: string
  plan: { nombre: string; fuente: string; pruebaHasta: string | null; limites: string } | null
  usuario: {
    nombre: string; frecuencia: string; disponible: number; ahorroTotal: number
    /** Ingreso MENSUAL con el que se planea (sueldo del mes, o estimación/promedio si es variable) */
    ingresoBase: number
    tipoIngreso: string
    /** Montos que cuentan como su sueldo (cada quincena o el mes); vacío si es variable */
    montosSueldo: number[]
    descripcionIngreso: string
  }
  categorias: { id: string; nombre: string; frecuencia: string; limite: number; gastado: number; disponible: number; estado: string }[]
  deudas: { id: string; nombre: string; tipo: string; saldo: number; cuota: number; tasaMensual: number | null; cupo: number | null; disponible: number | null; frecuencia: string; diasPago: string; pagadaEstePeriodo: boolean; atrasado: number; empiezaProximoPeriodo?: boolean }[]
  fijos: { id: string; nombre: string; monto: number; frecuencia: string; pagadoEstePeriodo: boolean; empiezaProximoPeriodo?: boolean }[]
  bolsillos: { id: string; nombre: string; meta: number; actual: number }[]
  meDeben: { id: string; persona: string; saldo: number; fechaCompromiso: string | null }[]
  hogar: { pareja: string; periodo: string; categorias: { id: string; nombre: string; limite: number; gastado: number; disponible: number }[] } | null
  movimientos: { fecha: string; tipo: string; nombre: string; monto: number }[]
  historial: { mes: string; ingresos: number; gastos: number; pagosObligaciones: number; ahorro: number }[]
}

const r = (n: unknown) => Math.round(Number(n ?? 0))
const dia = (d: Date) => d.toISOString().slice(0, 10)

export async function construirContexto(userId: string, now: Date = new Date()): Promise<ContextoIA> {
  const hace3 = new Date(now.getFullYear(), now.getMonth() - 2, 1)

  const [user, resumen, debtsRaw, fijosRaw, bolsillos, loans, hogar, gastos, ingresos, pagosDeuda, pagosFijo, ahorros] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { nombre: true, frecuenciaIngreso: true, ingresoBase: true, cashBalance: true, tipoIngreso: true, ingresoQuincena1: true, ingresoQuincena2: true } }),
    resumenCategorias(userId, 'periodo', now).catch(() => null),
    prisma.debt.findMany({ where: { userId, estado: 'activa' }, orderBy: { createdAt: 'asc' } }),
    prisma.fixedExpense.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.savingsPocket.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.externalLoan.findMany({ where: { userId, estado: 'activo' }, orderBy: { createdAt: 'asc' } }),
    resumenHogar(userId).catch(() => null),
    prisma.impulseExpense.findMany({ where: { userId, createdAt: { gte: hace3 } }, orderBy: { createdAt: 'desc' }, select: { nombre: true, monto: true, createdAt: true, esHormiga: true } }),
    prisma.incomeRecord.findMany({ where: { userId, createdAt: { gte: hace3 } }, orderBy: { createdAt: 'desc' }, select: { monto: true, tipo: true, createdAt: true } }),
    prisma.debtPayment.findMany({ where: { debt: { userId }, createdAt: { gte: hace3 }, esMarcador: false }, orderBy: { createdAt: 'desc' }, select: { montoPagado: true, createdAt: true, debt: { select: { nombre: true } } } }),
    prisma.fixedExpensePayment.findMany({ where: { fixedExpense: { userId }, createdAt: { gte: hace3 }, esMarcador: false }, orderBy: { createdAt: 'desc' }, select: { montoPagado: true, createdAt: true, fixedExpense: { select: { nombre: true } } } }),
    prisma.savingsHistory.findMany({ where: { userId, tipo: 'ahorro' }, orderBy: { createdAt: 'desc' }, select: { monto: true, createdAt: true } }),
  ])

  // Plan y límites (para que el coach sepa qué puede crear y no prometa lo que el plan no tiene)
  const plan = await resolverPlan(userId).catch(() => null)
  const lim = (v: string) => { const m = plan?.limites[v]?.maxValue; return m == null ? '?' : m >= 999999 ? '∞' : String(m) }
  const planCtx = plan ? {
    nombre: plan.planName, fuente: plan.fuente,
    pruebaHasta: plan.pruebaHasta ? dia(new Date(plan.pruebaHasta)) : null,
    limites: `categorías ${lim('nCategorias')}, deudas ${lim('nDeudas')}, gastos fijos ${lim('nGastosFijos')}, bolsillos ${lim('nBolsillos')}, me deben ${lim('nMeDeben')}, ingresos extra ${lim('nIngresosExtra')}, conexiones ${lim('nConexiones')}; préstamos/deudas compartidas ${plan.features.p2pLoans ? 'sí' : 'no'}; hogar ${plan.features.householdBudget ? 'sí' : 'no'}`,
  } : null

  const promedioIngreso = user.tipoIngreso === 'variable' ? await ingresoPromedioMensual(userId, now) : 0
  const ctxDeudas = await cargarContextoDeudas(debtsRaw)
  const deudas = debtsRaw.map(d => {
    const s = serializarDeuda(d, ctxDeudas)
    return {
      id: d.id, nombre: d.nombre, tipo: d.tipoDeuda === 'TARJETA_CREDITO' ? 'tarjeta' : d.tipoDeuda === 'CREDITO_COMPRAS' ? 'crédito de compras' : 'préstamo',
      saldo: r(d.saldoRestante), cuota: r(s.cuotaPeriodo), tasaMensual: s.tasaInteresAplicada ?? s.tasaInteres,
      cupo: s.cupoTotal != null ? r(s.cupoTotal) : null, disponible: s.cupoDisponible != null ? r(s.cupoDisponible) : null,
      frecuencia: d.frecuenciaPago, diasPago: d.diasPago, pagadaEstePeriodo: s.pagadoEstePeriodo, atrasado: r(s.montoAtrasado), empiezaProximoPeriodo: !!s.pendienteProximoPeriodo,
    }
  })

  const pagosFijosPeriodo = fijosRaw.length
    ? await prisma.fixedExpensePayment.findMany({ where: { fixedExpenseId: { in: fijosRaw.map(f => f.id) } }, select: { fixedExpenseId: true, periodo: true, montoPagado: true } })
    : []
  const fijos = fijosRaw.map(f => {
    const periodo = fixedPeriodo(f, now)
    const pagado = pagosFijosPeriodo.filter(p => p.fixedExpenseId === f.id && p.periodo === periodo).reduce((s, p) => s + Number(p.montoPagado), 0)
    return { id: f.id, nombre: f.nombre, monto: r(f.monto), frecuencia: f.frecuencia, pagadoEstePeriodo: pagado >= getMontoPorPeriodo(Number(f.monto), f.frecuencia, now), empiezaProximoPeriodo: !!f.activoDesdePeriodo && f.activoDesdePeriodo > periodo }
  })

  // Movimientos recientes (para "¿por qué bajó mi saldo?", "explícame este movimiento")
  const movimientos = [
    ...gastos.map(g => ({ fecha: g.createdAt, tipo: g.esHormiga ? 'gasto hormiga' : 'gasto', nombre: g.nombre, monto: -r(g.monto) })),
    ...ingresos.map(i => ({ fecha: i.createdAt, tipo: i.tipo === 'salario' ? 'ingreso (salario)' : 'ingreso extra', nombre: 'Ingreso', monto: r(i.monto) })),
    ...pagosDeuda.map(p => ({ fecha: p.createdAt, tipo: 'pago de deuda', nombre: p.debt.nombre, monto: -r(p.montoPagado) })),
    ...pagosFijo.map(p => ({ fecha: p.createdAt, tipo: 'pago de gasto fijo', nombre: p.fixedExpense.nombre, monto: -r(p.montoPagado) })),
    ...ahorros.filter(a => a.createdAt >= hace3).map(a => ({ fecha: a.createdAt, tipo: 'ahorro', nombre: 'Depósito a ahorro', monto: -r(a.monto) })),
  ].sort((a, b) => b.fecha.getTime() - a.fecha.getTime()).slice(0, 20).map(m => ({ ...m, fecha: dia(m.fecha) }))

  // Historial REAL de los últimos 3 meses (mes en curso incluido)
  const historial = [2, 1, 0].map(i => {
    const desde = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const hasta = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    const en = (d: Date) => d >= desde && d < hasta
    return {
      mes: desde.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' }) + (i === 0 ? ' (en curso)' : ''),
      ingresos: r(ingresos.filter(x => en(x.createdAt)).reduce((s, x) => s + Number(x.monto), 0)),
      gastos: r(gastos.filter(x => en(x.createdAt)).reduce((s, x) => s + Number(x.monto), 0)),
      pagosObligaciones: r([...pagosDeuda, ...pagosFijo].filter(x => en(x.createdAt)).reduce((s, x) => s + Number(x.montoPagado), 0)),
      ahorro: r(ahorros.filter(x => en(x.createdAt)).reduce((s, x) => s + Number(x.monto), 0)),
    }
  })

  return {
    hoy: now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    plan: planCtx,
    usuario: {
      nombre: user.nombre.split(' ')[0],
      frecuencia: user.frecuenciaIngreso,
      ingresoBase: r(ingresoReferenciaMensual(user, promedioIngreso)),
      tipoIngreso: user.tipoIngreso,
      montosSueldo: montosDeSueldo(user, promedioIngreso),
      descripcionIngreso: describirIngreso(user, promedioIngreso),
      disponible: r(user.cashBalance),
      ahorroTotal: r(ahorros.reduce((s, a) => s + Number(a.monto), 0)),
    },
    categorias: (resumen?.categorias ?? []).map(c => ({ id: c.id, nombre: c.nombre, frecuencia: c.frecuenciaLimite, limite: r(c.limite), gastado: r(c.gastado), disponible: r(c.disponible), estado: c.estado })),
    deudas,
    fijos,
    bolsillos: bolsillos.map(b => ({ id: b.id, nombre: b.nombre, meta: r(b.meta), actual: r(b.montoActual) })),
    meDeben: loans.map(l => ({ id: l.id, persona: l.persona, saldo: r(l.saldoPendiente), fechaCompromiso: l.fechaCompromiso ? dia(l.fechaCompromiso) : null })),
    hogar: hogar ? {
      pareja: hogar.pareja.nombre.split(' ')[0], periodo: hogar.periodo,
      categorias: hogar.categorias.map(c => ({ id: c.id, nombre: c.nombre, limite: r(c.montoLimite), gastado: r(c.gastado), disponible: r(c.disponible) })),
    } : null,
    movimientos,
    historial,
  }
}

const $ = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`

/** El contexto en texto compacto para el prompt (con los ids que la IA debe usar). */
export function contextoComoTexto(c: ContextoIA): string {
  const u = c.usuario
  const lineas: string[] = []
  lineas.push(`Hoy: ${c.hoy}`)
  if (c.plan) lineas.push(`Plan: ${c.plan.nombre}${c.plan.fuente === 'prueba' && c.plan.pruebaHasta ? ` (días de PLUS ganados por invitar amigos, hasta ${c.plan.pruebaHasta})` : ''} · límites: ${c.plan.limites}. Si una acción supera el plan, avísale y sugiérele Mi plan.`)
  lineas.push(`Usuario: ${u.nombre} · ${u.descripcionIngreso} · disponible hoy ${$(u.disponible)} · ahorrado en total ${$(u.ahorroTotal)}`)
  lineas.push('\nCATEGORÍAS DE PRESUPUESTO [id | nombre | límite mensual o quincenal (el gasto se suma en ese mismo mes o quincena) | límite | gastado | disponible | estado]:')
  lineas.push(c.categorias.length ? c.categorias.map(x => `- ${x.id} | ${x.nombre} | ${x.frecuencia} | ${$(x.limite)} | ${$(x.gastado)} | ${$(x.disponible)} | ${x.estado}`).join('\n') : '- (no tiene categorías)')
  lineas.push('\nDEUDAS ACTIVAS [id | nombre | tipo | saldo (ocupado) | cuota | tasa mensual | cupo | disponible del cupo | frecuencia | días de pago | pagada este periodo | atrasado]:')
  lineas.push(c.deudas.length ? c.deudas.map(d => `- ${d.id} | ${d.nombre} | ${d.tipo} | ${$(d.saldo)} | ${$(d.cuota)} | ${d.tasaMensual != null ? d.tasaMensual + '%' : 'sin tasa'} | ${d.cupo != null ? $(d.cupo) : (d.tipo === 'préstamo' ? '-' : 'sin cupo registrado')} | ${d.disponible != null ? $(d.disponible) : '-'} | ${d.frecuencia} | ${d.diasPago} | ${d.pagadaEstePeriodo ? 'sí' : 'no'} | ${$(d.atrasado)}`).join('\n') : '- (sin deudas)')
  lineas.push('\nGASTOS FIJOS [id | nombre | monto | frecuencia | pagado este periodo]:')
  lineas.push(c.fijos.length ? c.fijos.map(f => `- ${f.id} | ${f.nombre} | ${$(f.monto)} | ${f.frecuencia} | ${f.pagadoEstePeriodo ? 'sí' : 'no'}`).join('\n') : '- (sin gastos fijos)')
  // Totales ya hechos: probando con la IA real, el modelo sumaba mal cifras
  // grandes ("debes $8.047.700" con un crédito de $4.800 millones) y daba por
  // pendiente una tarjeta ya pagada. Usar SIEMPRE estos totales, no recalcular.
  const pendientes = [
    ...c.deudas.filter(d => !d.pagadaEstePeriodo && !d.empiezaProximoPeriodo).map(d => ({ n: d.nombre, v: d.cuota })),
    ...c.fijos.filter(f => !f.pagadoEstePeriodo && !f.empiezaProximoPeriodo).map(f => ({ n: f.nombre, v: f.monto })),
  ]
  const nuevas = [...c.deudas.filter(d => d.empiezaProximoPeriodo), ...c.fijos.filter(f => f.empiezaProximoPeriodo)].map(x => x.nombre)
  const pagadas = [...c.deudas.filter(d => d.pagadaEstePeriodo).map(d => d.nombre), ...c.fijos.filter(f => f.pagadoEstePeriodo).map(f => f.nombre)]
  lineas.push(`\nTOTALES (ya calculados, úsalos tal cual): saldo total de todas las deudas ${$(c.deudas.reduce((s, d) => s + d.saldo, 0))} · obligaciones YA PAGADAS este periodo: ${pagadas.join(', ') || 'ninguna'} · PENDIENTES por pagar este periodo: ${pendientes.map(p => `${p.n} ${$(p.v)}`).join(', ') || 'ninguna'} (total ${$(pendientes.reduce((s, p) => s + p.v, 0))})${nuevas.length ? ` · NUEVAS, empiezan a cobrarse el próximo periodo (no están pendientes ni vencidas): ${nuevas.join(', ')}` : ''}`)
  lineas.push('\nBOLSILLOS DE AHORRO [id | nombre | meta | ahorrado]:')
  lineas.push(c.bolsillos.length ? c.bolsillos.map(b => `- ${b.id} | ${b.nombre} | ${$(b.meta)} | ${$(b.actual)}`).join('\n') : '- (sin bolsillos)')
  lineas.push('\nME DEBEN [id | persona | saldo pendiente | fecha prometida]:')
  lineas.push(c.meDeben.length ? c.meDeben.map(l => `- ${l.id} | ${l.persona} | ${$(l.saldo)} | ${l.fechaCompromiso ?? 'sin fecha'}`).join('\n') : '- (nadie)')
  if (c.hogar) {
    lineas.push(`\nPRESUPUESTO DEL HOGAR con ${c.hogar.pareja} (${c.hogar.periodo}) [id | categoría | tope | gastado | disponible]:`)
    lineas.push(c.hogar.categorias.length ? c.hogar.categorias.map(h => `- ${h.id} | ${h.nombre} | ${$(h.limite)} | ${$(h.gastado)} | ${$(h.disponible)}`).join('\n') : '- (sin categorías del hogar)')
  } else {
    lineas.push('\nPRESUPUESTO DEL HOGAR: no tiene pareja conectada.')
  }
  lineas.push('\nHISTORIAL REAL (por mes):')
  lineas.push(c.historial.map(h => `- ${h.mes}: ingresos ${$(h.ingresos)} · gastos ${$(h.gastos)} · pagos de obligaciones ${$(h.pagosObligaciones)} · ahorro ${$(h.ahorro)}`).join('\n'))
  lineas.push('\nÚLTIMOS MOVIMIENTOS:')
  lineas.push(c.movimientos.length ? c.movimientos.map(m => `- ${m.fecha} · ${m.tipo} · ${m.nombre} · ${m.monto >= 0 ? '+' : '-'}${$(Math.abs(m.monto))}`).join('\n') : '- (sin movimientos todavía)')
  return lineas.join('\n')
}
