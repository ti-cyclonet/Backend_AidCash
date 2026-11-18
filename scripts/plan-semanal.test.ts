/** Pruebas puras del plan semanal (sin base de datos): npx tsx scripts/plan-semanal.test.ts */
import assert from 'node:assert/strict'
import { rangoDeCobro, partirEnSemanas, disponibleParaGastar } from '../src/lib/plan-semanal.js'

const d = (s: string) => { const [y, m, dd] = s.split('-').map(Number); return new Date(y, m - 1, dd, 12) }
const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
let ok = 0
const t = (nombre: string, fn: () => void) => { fn(); ok++; console.log('  ok', nombre) }

t('quincenal 15/30 a mitad de noviembre', () => {
  const r = rangoDeCobro('quincenal', [15, 30], d('2026-11-20'))
  assert.equal(ymd(r.inicio), '2026-11-15'); assert.equal(ymd(r.fin), '2026-11-30')
})
t('quincenal 15/30 en febrero cae el 28', () => {
  const r = rangoDeCobro('quincenal', [15, 30], d('2027-02-20'))
  assert.equal(ymd(r.inicio), '2027-02-15'); assert.equal(ymd(r.fin), '2027-02-28')
})
t('quincenal 15/30 el 3 de diciembre sigue en la Q2 de noviembre', () => {
  const r = rangoDeCobro('quincenal', [15, 30], d('2026-12-03'))
  assert.equal(ymd(r.inicio), '2026-11-30'); assert.equal(ymd(r.fin), '2026-12-15')
})
t('mensual día 30, cambio de año', () => {
  const r = rangoDeCobro('mensual', [30], d('2027-01-10'))
  assert.equal(ymd(r.inicio), '2026-12-30'); assert.equal(ymd(r.fin), '2027-01-30')
})
t('mensual sin días = día 1', () => {
  const r = rangoDeCobro('mensual', [], d('2026-11-14'))
  assert.equal(ymd(r.inicio), '2026-11-01'); assert.equal(ymd(r.fin), '2026-12-01')
})
t('día de pago hoy abre periodo nuevo', () => {
  const r = rangoDeCobro('quincenal', [1, 16], d('2026-11-16'))
  assert.equal(ymd(r.inicio), '2026-11-16'); assert.equal(ymd(r.fin), '2026-12-01')
})
t('quincena de 15 días → 8 + 7', () => {
  const s = partirEnSemanas(d('2026-11-15'), d('2026-11-30'), 2)
  assert.deepEqual(s.map(x => x.dias), [8, 7]); assert.equal(ymd(s[1].inicio), '2026-11-23'); assert.equal(ymd(s[1].fin), '2026-11-30')
})
t('mes de 31 días en 4 → 8,8,8,7', () => {
  const s = partirEnSemanas(new Date(2026, 9, 1), new Date(2026, 10, 1), 4)
  assert.deepEqual(s.map(x => x.dias), [8, 8, 8, 7])
})
t('febrero de 28 en 4 → 7 cada una', () => {
  assert.deepEqual(partirEnSemanas(new Date(2027, 1, 1), new Date(2027, 2, 1), 4).map(x => x.dias), [7, 7, 7, 7])
})
t('distribución igual a la de Billetera', () => {
  const r = disponibleParaGastar(1_000_000, 300_000) // remanente 70% → ahorro 20%
  assert.equal(r.remanente, 700_000); assert.equal(r.ahorro, 200_000); assert.equal(r.libre, 500_000)
})
t('obligaciones mayores al saldo → nada para gastar', () => {
  const r = disponibleParaGastar(200_000, 300_000)
  assert.equal(r.libre, 0); assert.equal(r.sobrecargado, true)
})
t('sin saldo', () => assert.equal(disponibleParaGastar(0, 0).libre, 0))
t('ya ahorró lo sugerido: no se vuelve a pedir ahorro', () => {
  // Antes: saldo 3.200.000, obligaciones 465.000 → ahorro 640.000. Ahorra eso → saldo 2.560.000
  const r = disponibleParaGastar(2_560_000, 465_000, 640_000)
  assert.equal(r.metaAhorro, 640_000); assert.equal(r.ahorro, 0); assert.equal(r.libre, 2_095_000)
})
t('ahorro parcial: solo pide lo que falta', () => {
  const r = disponibleParaGastar(2_900_000, 465_000, 300_000)
  assert.equal(r.metaAhorro, 640_000); assert.equal(r.ahorro, 340_000); assert.equal(r.libre, 2_095_000)
})
console.log(`${ok} pruebas ok`)
