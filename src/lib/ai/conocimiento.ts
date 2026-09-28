/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Kiri Finance — Manual de la app para Kiri Coach
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Todo lo que Kiri Coach sabe de la app sale de aquí: módulos, cada función,
 * dónde está cada botón y las reglas reales con las que Kiri calcula. Si
 * cambia una función de la app, actualiza este texto (y la guía de módulos en
 * Frontend_AidCash/src/lib/module-guide-content.ts): si no está aquí, el coach
 * no lo sabe, y si está mal aquí, el coach lo explicará mal.
 */

export const MANUAL_KIRI = `
# KIRI FINANCE — MANUAL COMPLETO

Kiri Finance es una app colombiana (pesos COP) de finanzas personales. Su idea: tu dinero es un
jardín; el Árbol Kiri crece o se marchita según tus decisiones financieras reales. Todo se
organiza por PERIODO: mensual o quincenal, según cómo cobre el usuario (se elige al registrarse
con sus días de pago; se cambia en Perfil).

## NAVEGACIÓN
- En PC: barra lateral con Árbol Kiri, Gestión, Obligaciones, Balance, Ahorro, Social, Misiones y
  el perfil abajo. La campana de notificaciones está arriba en la barra lateral.
- En celular: barra superior (Social, campana, foto de perfil) y barra inferior con Gestión,
  Obligaciones, botón "+" (acciones rápidas), Balance y Ahorro.
- Botón flotante de Kiri Coach 🌱 (abajo a la derecha): abre el chat. En PC, al pasar el mouse
  muestra tres atajos: Dictar datos (voz), Simulador y Escanear recibo. En celular esos atajos
  salen en el "+" de la barra inferior. Dentro del chat también están el micrófono y el escáner.

## ÁRBOL KIRI (Jardín) — ruta /jardin
- Es el punto de partida. Muestra el árbol, su nivel y su salud.
- XP y niveles: Semilla → … → Jardín próspero. Niveles en 0, 850, 1.850, 4.350, 8.350 y 14.350 XP
  (el 2 pide 850, el 3 mil más, y cada nivel siguiente pide más). XP sale de misiones, rachas (40 XP), insignias (50 XP), que te rieguen
  amigos y de invitar gente.
- Salud (0-100%): sube si registras ingresos, ahorras, controlas deudas y estás al día.
- Clima: ahorrar → llueve; registrar un ingreso → sale el sol y caen monedas; un pago por vencer
  (7 días) → nubes; pagos vencidos → tormenta con rayos y truenos (se pueden silenciar); un gasto
  hormiga → cae un rayo. Tocar las nubes muestra qué obligaciones están vencidas y cuáles vencen
  pronto, con su monto.
- Botones: "Regar" (a la izquierda) riega el jardín; "Invitar" (a la derecha) abre el enlace de
  invitación (Amigo, Familia o Pareja) con botones Copiar y Compartir.
- Tarjeta "Progreso general": Disponible frente al ingreso, avance de ahorros, % pagado de deudas y
  colchón de emergencia (cuántos meses de obligaciones cubren tus ahorros).
- Consejos contextuales con botón "Otro consejo".

## MISIONES — ruta /misiones
- Misiones diarias (5, 10 o 20 XP), una semanal (60 XP), cofres para reclamar y racha de días.
- Misiones de invitar: invitar 1, 2 y 3 personas (25, 50 y 75 XP). Solo cuentan personas NUEVAS que
  se registran con tu enlace y verifican su correo; quedan conectados automáticamente en Social.
  Alguien que ya tenía cuenta y abre el enlace queda conectado, pero no cuenta para la misión.
- Recordatorios de misiones pendientes a las 10:30 y 18:30, y a las 20:00 "¿Registraste tus gastos
  de hoy?".

## GESTIÓN — ruta /gestion (pestañas Billetera, Presupuesto, Proyecciones)
### Billetera
- "Sueldo base" = lo que planeas recibir por periodo (quincena o mes). "Sueldo real / Disponible"
  = la plata que de verdad tienes; baja al pagar obligaciones o registrar gastos y sube al
  registrar ingresos.
- Registrar ingreso: tipo "salario" (tu pago) o "extra". Al registrar el salario, Kiri reparte en
  la billetera: primero lo de obligaciones; del resto, un % a ahorro que depende de cuánto te
  queda libre (20% si queda ≥40% del ingreso, 15% si ≥25%, 10% si ≥15%, 5% si menos); de lo que
  sobra, hasta 15% del ingreso es "gasto libre" del día a día y lo demás "capacidad de
  endeudamiento/inversión".
- Pagos automáticos ⚡: las obligaciones marcadas con pago automático se pagan solas al registrar
  el sueldo.
- Ingresos extra: pueden ser de una vez, por unos meses (definido) o indefinidos.
### Presupuesto
- Categorías de gasto (ej. Comida, Transporte, Salidas) con un límite mensual; en quincenal Kiri
  lo reparte por quincena. Se pueden vincular gastos fijos a una categoría.
- Cada gasto registrado puede ir a una categoría; Kiri sugiere la categoría según tu historial y
  palabras clave. Avisa al llegar al 80% y al pasar el 100% del límite.
- Tocar una categoría abre su detalle (lo gastado, movimientos); el lápiz la edita y el botón
  "Gasto" registra un gasto directo en ella.
- Gastos hormiga: gastos pequeños y cotidianos que sumados se comen el disponible. Kiri marca
  hormiga un gasto de hasta $50.000 o si su nombre es de consumo típico (café, tinto, domicilio,
  Rappi, Uber, InDriver, taxi, bus, snacks, gaseosa, cerveza, cine, propina, recarga…). El
  usuario puede cambiarlo.
### Proyecciones
- Compara "Siguiendo igual" (pagas tus cuotas y ahorras lo que vienes ahorrando, promedio real de
  3 meses) con "Tu plan Kiri": un aporte extra al mes (el usuario lo mueve con un control; Kiri
  sugiere la mitad de lo que le queda libre) que va a la deuda más cara (Avalancha, si hay tasas)
  o la más pequeña (Bola de Nieve, si no); cuando una deuda termina, su cuota pasa a la siguiente;
  sin deudas, todo va a ahorro. Opción "Recortar la mitad de los gastos hormiga".
- Muestra el día en que quedas libre de deudas, intereses que te ahorras, logros (cada deuda
  pagada, colchón de 1 mes, fondo de emergencia de 3 meses, patrimonio en positivo), y "¿Con qué
  datos se calcula?". Horizonte de 3, 6, 12 o 24 meses.

## OBLIGACIONES — ruta /obligaciones
- Todo lo que debes pagar: deudas (préstamos y tarjetas de crédito) y gastos fijos (arriendo,
  servicios, internet, suscripciones; frecuencia mensual, quincenal, semanal o anual).
- Para cada una: cuota, día de pago, saldo, tasa de interés MENSUAL (ej. 1,85% mes vencido) y
  pago automático ⚡. Se paga con el check/botón de pagar.
- Al pagar puedes escribir el "saldo real del banco": Kiri calcula el interés real que pagaste y
  ajusta la tasa. Si pagaste un poco menos (ej. llegó $180.000 y no $182.000), marca "Con este
  valor quedó pagada la cuota".
- Atrasos: marca cuotas de periodos anteriores sin pagar. Se puede adelantar la próxima cuota y
  deshacer el último abono o todo el pago del periodo.
- Tarjetas de crédito: pagar una deuda o gasto fijo con tarjeta lo convierte en consumo a cuotas
  (el interés se calcula igual y la cuota de la tarjeta sube; baja sola cuando termina).
- Registrar gasto (botón en Obligaciones): nombre, monto, categoría de presupuesto, si es hormiga,
  y si tienes pareja, "Del hogar" para sumarlo al presupuesto compartido. También puede pagarse
  con tarjeta de crédito.
- "Me deben": plata que prestaste a personas que no usan Kiri. Sale de tu disponible; registras
  sus abonos (vuelven a tu billetera), fecha de pago prometida con recordatorios y botón para
  recordarle por WhatsApp. Se puede ampliar, perdonar o reabrir.
- Estrategias de deuda: Bola de Nieve (primero la más pequeña) y Avalancha (primero la de tasa
  más alta).

## BALANCE — ruta /balance
- Filtra por periodo; 6 indicadores (balance neto, total recibido, total gastado, ahorro del
  periodo, interés pagado, interés evitado por abonos extra), gráficos de evolución, ingresos vs
  egresos y gasto por categoría.
- Botón Historial: movimientos con buscador y filtros; "Elegir mes" para meses anteriores (en
  quincenal separados en Periodo 1 y 2). Un gasto registrado por error se elimina desde el
  historial: la plata vuelve a tu disponible (o a la tarjeta).
- El historial también muestra lo de Social: préstamos entre usuarios (dados, recibidos y previos),
  sus abonos y los aportes/retiros de ahorros compartidos. Los préstamos y abonos no cuentan como
  ingreso ni gasto (como "Me deben"); los aportes a ahorros compartidos sí suman al ahorro.
- Exportar a PDF (eliges el mes).

## AHORRO — ruta /ahorro
- Bolsillos de ahorro con nombre, color, ícono y meta (libre o con fecha límite). "Depositar"
  pasa plata del disponible al bolsillo (el árbol llueve); "Retirar" la devuelve.
- Fondo de emergencia: meta mínima 3 meses de obligaciones, ideal 6.
- Los bolsillos compartidos de Social también aparecen aquí.

## SOCIAL — ruta /social (pestañas Conexiones, Ahorros, Préstamos, Deudas)
- Conexiones: buscar por usuario o correo, o enviar el enlace de invitación; rol Amigo, Familia o
  Pareja (cambiar el rol lo debe aprobar el otro). Pueden regarse el jardín y hay ranking.
- Presupuesto del hogar (solo con Pareja): categorías compartidas (Comida, Mercado, Salidas,
  Viajes, Renta, Servicios…) con un tope MENSUAL o QUINCENAL (1–15 y 16–fin de mes) que cualquiera
  de los dos cambia; al cambiar se pueden convertir los topes (mitad / doble). Cada gasto sale de
  la billetera de quien lo hace y suma al tope; al otro le llega aviso, y a los dos al 80% y al
  pasarse. Se registra con el botón "Gasto" de la categoría o eligiendo "Del hogar" al registrar
  un gasto.
- Bolsillos compartidos: metas de ahorro en grupo con calculadora para aportar según ingresos.
  "Retirar" pide un retiro que aprueba la otra persona del bolsillo (nadie aprueba lo suyo).
  Al crearlo se puede marcar "Ya tenemos algo ahorrado para esto" y, al aportar, "Esta plata ya la
  tenía ahorrada": suma al bolsillo SIN descontarla de la billetera (para lo que ya tenían guardado).
- Préstamos entre usuarios de Kiri: pides prestado con fecha de pago (1 semana, 15 días, fin de
  mes, 1 mes u otra); el otro aprueba; abonos confirmados por ambos; cualquiera cambia la fecha;
  recordatorios el día antes, el día y si hay atraso. Un préstamo NUEVO mueve plata: sale de la
  billetera de quien presta y entra a la de quien recibe.
- "Ya nos prestamos antes": registrar un préstamo que ya existía (aunque esa plata ya se gastó).
  Se elige "Yo le presté" o "Me prestó", cuánto se prestó y cuánto falta si ya hubo abonos. NO mueve
  plata de ninguna billetera; la otra persona lo confirma ("Sí, es correcto" / "No es así") y desde
  ahí llevan juntos los abonos (esos sí mueven plata). Quien lo registró lo puede retirar mientras
  no esté confirmado. Aparece con la etiqueta "Previo".
- Deudas compartidas (pareja/familia): informativas, con la parte de cada uno, cuota, día de pago y
  % pagado. Si es una deuda que ya venían pagando, se marca y se escribe cuánto falta hoy (y si ya
  pagaron la cuota de este mes), así los dos ven el avance real.
- La tarjeta de perfil de cada conexión (al tocar a la persona) muestra rol, ahorros y préstamos
  entre ustedes; la de la pareja va en rosa.

## PERFIL — ruta /perfil
- Foto (se guarda en la cuenta), datos, frecuencia de ingreso, "Notificaciones del celular"
  (Activar / Probar), Guía de Kiri (volver a ver las guías), plan y cerrar sesión.

## NOTIFICACIONES
- Campana: solicitudes y avisos de Social, préstamos, hogar, misiones, pagos por vencer, consejos.
- Al celular (barra de notificaciones) si se activan en Perfil.

## REGISTRO RÁPIDO CON KIRI COACH
- Dictado por voz: "gasté 20 mil en almuerzo", "me pagaron 2 millones", "ahorré 100 mil para el
  viaje", "pagué la cuota del carro", "le presté 50 mil a Juan"... Kiri propone cada movimiento en
  tarjetas que el usuario revisa, corrige y confirma antes de guardar.
- Escáner de recibos: foto de una factura; Kiri lee el total, el comercio y los ítems. Si entiende
  el valor pero no a qué corresponde, el usuario elige a dónde va.
- Simulador: prueba escenarios de deuda/abonos.
- En el chat, Kiri Coach también puede proponer acciones (registrar gasto o ingreso, crear
  categoría, deuda, gasto fijo o bolsillo, ahorrar, pagar una obligación, registrar un "Me deben").
  Nada se guarda sin que el usuario toque "Confirmar".
`.trim()
