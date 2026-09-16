# El portal de pagos en línea ahora le pregunta a nexus

**Puesto en producción el 2026-09-10.**

`https://vestel.com.co/crm` es una aplicación aparte (CodeIgniter, base propia
`crm_vestel`). No tiene lógica de facturación: **le pregunta todo por HTTP** a un web
service y arma con la respuesta el widget de Wompi. Hasta hoy ese web service era el
legacy. Ahora es este sistema.

```
ANTES                                        AHORA
vestel.com.co/crm                            vestel.com.co/crm
   │  POST                                      │  POST
   ▼                                            ▼
vestel.saves.com.co/Servicio/*   (legacy)    app.saves.com.co/api/portal-pagos/*  (nexus)
```

## Los cinco métodos

Se responden con la **forma exacta** que servía
`saves-vestel/application/controllers/Servicio.php`. El portal hace `json_decode` y va
directo a las llaves: una que falte es una página en blanco para alguien que está
pagando. Todo eso vive en `backend/src/portal-pagos/`.

| método | qué devuelve |
|---|---|
| `get_due_customer` | deuda, ficha del cliente, promos y llaves de Wompi |
| `inv_list` | la tabla de facturas (DataTables server-side) |
| `view_service` | el HTML de una factura |
| `aplicar_discount` | ya no escribe nada (ver abajo) |
| `pay_due_customer` | aplica el pago que Wompi cobró |

## Por qué se hizo

**El descuento.** Lo que el portal le cobra al cliente es literalmente
`due.total - due.pamnt`, firmado con la llave de integridad de Wompi. Devolviendo aquí
la deuda **ya rebajada** por las promociones vigentes hoy —con sus fechas y su alcance,
`Promotion.startDate`/`endDate`—, el portal cobra rebajado sin enterarse. Eso deja sin
trabajo a tres parches que existían sólo para esto:

- el `else { $promo = 5; }` de `Servicio::aplicar_discount`, que regalaba el descuento
  aunque no hubiera promoción vigente (20,7 M COP históricos);
- el descuento escrito en la cabecera de la factura, que **no caducaba**: se concedía
  el día 3 y se pagaba el 20 con la rebaja puesta;
- `portalPreapply`, que iba concediendo notas crédito **por adelantado** en el legacy
  para que el portal las viera, y había que retirarlas si el cliente no pagaba.

La promoción se concede donde siempre: **al cobrar**, dentro de la transacción del pago,
y sólo si el pago salda la factura entera.

**El pago.** `pay_due_customer` entra por `CobranzasService.collect`, el mismo camino
que la ventanilla: cascada, reconexión, prorrateo, anticipos y e-factura. Antes lo
aplicaba `Customers_model::pay_invoices()` del legacy, que además abría **su propia**
orden de reconexión y **su propia** factura prorrateada; como este sistema hacía lo mismo
al ver el pago entrar por el sync, el abonado acababa con el cargo dos veces (11 casos
entre el 28-ago y el 9-sep de 2026). Con un solo sistema cobrando eso no puede repetirse.

El dinero sigue llegando al legacy: lo lleva el writeback (`LEGACY_WRITEBACK_CAJA_LIVE`),
que deja allá la fila en `transactions`, el saldo de la caja, el acumulado del cliente y
la factura en `paid`.

## Lo que se cambió en el portal (3 ficheros, 5 líneas)

Respaldos y script de vuelta atrás en **`/root/backups-portal-pagos/`**
(`REVERTIR.sh` restaura los tres ficheros del respaldo más reciente).

| fichero | cambio |
|---|---|
| `application/modules/user/controllers/User.php` | `$_SESSION['url_web_service']` → nexus |
| `application/models/Communication_model.php` | los dos respaldos de esa URL + **secreto rotado** |
| `application/controllers/Invoices.php` | fija la URL también en su constructor |

Lo último no es adorno: la URL se fijaba sólo al pasar por `User`, así que una sesión ya
abierta seguía llamando al legacy. Fijándola también aquí, cualquier sesión vieja se
corrige sola en su siguiente petición.

**El secreto se rotó.** El apretón de manos son dos md5 de sendas frases en el PHP del
portal; las anteriores estaban en copias del código legacy que han circulado, y con
ellas se podía saldar una factura con un POST. Las frases nuevas viven **sólo** en
`Communication_model.php`; aquí sólo están sus md5 (`PORTAL_WS_USER_MD5` /
`PORTAL_WS_PASS_MD5`), y además hay lista blanca de IPs (`PORTAL_WS_IPS`).

**Efecto colateral de esa rotación (2026-09-10).** La MISMA pareja de frases
(`Communication_model::$us_str/$pss_str`) guarda el sentido contrario: el servicio
`crm/Servicio::update_user` con el que se le fija al abonado **la contraseña del portal**
(ficha del cliente → Acciones → Clave de pagos en línea, ver `OnlinePaymentsService`).
Al rotar sólo se cambiaron `PORTAL_WS_*`, y `PORTAL_CRM_TOKEN_USUARIO` /
`PORTAL_CRM_TOKEN_CLAVE` se quedaron con el md5 viejo: el portal cortaba en
`sfgsagety785625x` **antes de escribir**, devolviendo 200 con el cuerpo vacío, y ninguna
clave cambiaba. Corregido poniendo los cuatro valores iguales. **Al rotar hay que cambiar
los CUATRO.** `update_user` ahora exige que el cuerpo sea `1` y dice que es la llave, no
el cliente.

Sigue con la frase vieja la copia del legacy (`Notas_model::$us_str/$pss_str`), así que
su botón **"Change Password"** no escribe nada y no avisa: esa clave se cambia desde
aquí.

## Interruptores

```
PORTAL_WS_ENABLED=true          # apagado -> 503 (el portal enseña el error)
PORTAL_WS_USER_MD5=...          # md5 de la frase de usuario que manda el portal
PORTAL_WS_PASS_MD5=...          # md5 de la frase de clave
PORTAL_WS_IPS=127.0.0.1,...     # de dónde se acepta la llamada (vacío = sin lista)
PORTAL_WS_CASH_ACCOUNT_ID=23    # cuenta WOMPI del legacy
PORTAL_WS_RESCATE_DIAS=3        # ventana de la red de seguridad
PORTAL_CRM_BASE=https://vestel.com.co/crm
```

## La red de seguridad (y por qué hace falta)

El aviso del portal es un **disparo único, sin reintentos**:
`Tickets::data_reception_wompi` marca la orden como aprobada y sólo entonces llama al
pago, dentro de un `if ($orden->estado == "Inicial")` que él mismo acaba de dejar de
cumplir. Si esa llamada falla, nadie la repite: el cliente pagó y su factura se queda
abierta.

Y falló: **el primer pago que pasó por aquí** (10-09, 04:22 CEST) se cayó porque la
transacción interactiva de Prisma se pasó del tope por defecto de 5 s (tardó 15,3 s con
Postgres ocupado). Entró en un segundo intento. Dos frenos desde entonces:

1. `collect` abre su transacción con **30 s** de tope (`maxWait` 10 s). Ya había
   reventado antes en ventanilla (9.376 ms el 02-09).
2. `PortalPagosService.recogerPagosCaidos()`, que corre en el cron `pagos-en-linea`
   (cada 5 min): busca órdenes **aprobadas en el portal, sin sellar aquí y sin ningún
   movimiento con esa referencia** y las aplica. Es idempotente y vuelve a comprobar la
   orden contra `crm_vestel`.

## El candado de la ida

Un recaudo hecho aquí tarda hasta un ciclo en llegar al legacy (writeback en
:07/:22/:37/:52; la ida cada 15 min). Si la ida pasaba primero veía `paid` aquí y `due`
allá y **revertía el cobro**. Con la ventanilla eso era un desajuste de quince minutos;
con el portal preguntando aquí sería un **cobro doble**: al cliente que acaba de pagar
se le vuelve a ofrecer la misma factura con su botón de Wompi.

`scripts/sync-legacy-vivo.js` ya no lo hace: si hay un movimiento de este lado
(`legacyId: null`, vigente) contra esa factura y aquí figura más pagado que allá, el
cobro no se pisa. La condición se apaga sola en cuanto el writeback iguala los dos lados.

## Comprobaciones

```bash
# ¿diría nexus lo mismo que el legacy? (no escribe nada)
npm run comparar:portal-pagos -- --n=300
npm run comparar:portal-pagos -- --todos

# el módulo de punta a punta, contra una base desechable
createdb saves_portal_test
DATABASE_URL=...saves_portal_test npx prisma migrate deploy
DATABASE_URL=...saves_portal_test npm run smoke:portal-pagos
```

El contraste del 2026-09-10 sobre los 300 últimos que usaron el portal: **285 idénticos**
y 15 distintos, y en los 15 **el equivocado es el legacy** —11 son céntimos (su
`invoices.total` es `int`, y de todos modos por debajo de $1.000 el portal no ofrece
pagar), 3 son su `SUM(total)-SUM(pamnt)` contra su propio `status` y 1 es una factura
que se anuló aquí y allá quedó de fantasma.

## Dónde se ven los pagos

| dónde | qué se ve | quién |
|---|---|---|
| **`/tesoreria/pagos-en-linea`** | la pantalla del asunto: cada intento del portal, con su estado en la pasarela, si la plata llegó a cartera, **qué facturas saldó**, el recibo, quién lo aplicó y si hubo reconexión | contabilidad, administración, gerencia |
| `/tesoreria/ingresos` | el movimiento, en la cuenta **WOMPI** como cualquier otro ingreso | según el alcance de caja |
| Ficha del cliente | el pago en sus movimientos y la factura ya en PAGADA | quien vea al cliente |
| Cierre de caja | la fila **WOMPI** del bloque «Forma de pago» (va aparte de «Transferencia» a propósito) | caja, contabilidad |
| Recibo de caja | se materializa al pagar, igual que en ventanilla | desde el movimiento |

La cifra que hay que vigilar es **«Sin aplicar»** en la cabecera de la pantalla: aprobado
por Wompi y sin movimiento en cartera = al cliente le cobraron y su deuda no bajó. Hoy
está en **0** sobre las 3.189 aprobadas del histórico.

Ese contador daba dos falsos positivos ($148.650) porque el legacy no siempre escribía
`transactions.id_orden_payu` y el emparejamiento era sólo por referencia: el abonado
55200 (73.150 del 3-ago, imputado en WOMPI dos días después sin referencia) y el 55793
(75.500 del 10-jul, que el legacy imputó contra `BANCOLOMBIA TELECOMUNICACIONES`, o sea
que entró por el cargue de pagos por Excel). Ahora, cuando no hay referencia, se intenta
un emparejamiento por abonado + valor + fecha (±5 días) y la pantalla lo marca como
**«Aplicado ~»** para que nadie lo confunda con una conciliación de verdad. Lo que aplica
este sistema siempre lleva la referencia, así que esa red sólo pesca histórico.

**Quién aplicó** cada pago es una columna propia (`PaymentOrder.appliedBy`), no una
deducción: mirar el movimiento no sirve porque el writeback **adopta** el gemelo del
legacy y le estampa su `legacyId`, con lo que un recaudo nacido aquí acaba pareciendo
traído de allá.

## Lo que queda pendiente

- **`portalPreapply` / cron `descuento-portal`** ya no hacen falta: existían para que el
  legacy enseñara el valor rebajado. Se dejan encendidos porque la caja del legacy
  todavía cobra a mano y necesita ver ese total; se apagan el día que nadie cobre allá.
- **El desplegable de recibos** de la tabla de facturas no se reprodujo: el legacy lo
  montaba con enlaces a `www.saves-vestel.com/comprobantes`, dominio que ya no resuelve.
  Era un botón que sólo podía dar error. Vuelve cuando los recibos de este sistema
  tengan una URL que un cliente sin sesión pueda abrir.
