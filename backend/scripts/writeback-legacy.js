/**
 * Retro-sincronización  saves_vestel (PostgreSQL)  →  admin_vestel (MySQL VIVO del legacy).
 *
 * La pieza de vuelta del plan "los dos sistemas de la mano": lo que se capture en el
 * stack nuevo se refleja en el legacy, para poder conmutar a él si el nuevo falla y
 * que los trabajadores no paren ni se pierdan datos.
 *
 * Qué empuja (vertical Clientes+Facturación+Caja, mismo alcance que la ida):
 *   · INSERTS — filas creadas en el stack nuevo (legacyId=null): clientes, facturas
 *     (+ítems), transacciones, recibos (+puente), anulaciones, estados y ÓRDENES de
 *     servicio (`tickets`). Además la APERTURA de caja, que allá no es una fila sino
 *     un permiso por usuario (ver `pushCashOpens`). Tras insertar
 *     en MySQL se guarda el id asignado como legacyId en PG (queda enlazada y el sync
 *     de ida la reconoce como propia: sus skipDuplicates evitan el eco).
 *   · UPDATES — cambios hechos en el nuevo sobre filas de origen legacy: clientes
 *     (comparación campo a campo) y facturas (huella status/pamnt/total/ron/…).
 *
 * REGLA DE ORO (un solo sistema activo a la vez):
 *   · Modo A (legacy activo, hoy): LEGACY_SYNC_ENABLED=true. Los INSERTS pueden ir en
 *     vivo (no chocan con la ida), pero los UPDATES se quedan en plan: si corrieran,
 *     pelearían con la ida (que restaura lo del legacy) en un ping-pong sin fin.
 *   · Modo B (nuevo activo, tras el go-live): LEGACY_SYNC_ENABLED=false +
 *     LEGACY_WRITEBACK_LIVE=true. Todo corre en vivo; el legacy queda de espejo.
 *
 * Gates: sin LEGACY_WRITEBACK_LIVE=true todo va en seco (plan, sin escribir).
 * `LEGACY_WRITEBACK_TICKETS_LIVE=true` abre SOLO las órdenes de servicio (insert y
 * update) dejando el resto en plan: sirve para que el trabajo de campo viaje en los
 * dos sentidos sin meterle caja al legacy, que en Modo A es quien la manda.
 * `--target=copy` escribe en la BD de ensayo (LEGACY_WRITEBACK_TEST_DB, def.
 * `writeback_test`) ignorando los gates — SOLO para pruebas con filas de ensayo,
 * porque los legacyId que enlaza vienen de esa BD y no valen para producción.
 *
 * Uso:  node scripts/writeback-legacy.js [--dry] [--target=copy]
 * Siempre imprime un JSON de resumen en la última línea (lo consume CronService).
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

try {
  const envFile = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const { PrismaClient } = require('@prisma/client');
const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

const arg = (n) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : undefined;
};
const TARGET = (process.argv.find((a) => a.startsWith('--target=')) || '--target=prod').split('=')[1];
const LIVE_GATE = process.env.LEGACY_WRITEBACK_LIVE === 'true';
const MODE_A = process.env.LEGACY_SYNC_ENABLED === 'true'; // legacy activo (la ida corre)
// En producción sin gate → todo seco. En copy → escribir siempre (BD de ensayo).
const DRY = process.argv.includes('--dry') || (TARGET !== 'copy' && !LIVE_GATE);
/**
 * Gate SOLO para órdenes de servicio. Deja que las órdenes viajen al legacy mientras
 * el resto del writeback (clientes, facturas, caja) sigue en plan: en Modo A la caja
 * de allá es la que manda y meterle transacciones y recibos desde aquí es un problema
 * de cuadre, no una mejora. `--dry` explícito lo apaga también.
 */
const TICKETS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_TICKETS_LIVE === 'true');
/**
 * Gate SOLO para la CAJA: movimientos, recibos, anulaciones y el enlace del
 * comprobante. Mismo espíritu que el de órdenes — deja que la plata capturada aquí
 * llegue al legacy sin abrir todavía el writeback entero (clientes y facturas
 * siguen retenidos, que es donde está el riesgo de pisar la fuente de verdad).
 *
 * Se abrió el 2026-08-24: sin él, lo cobrado en este sistema no existía para el
 * legacy — el abonado pagaba aquí y allá seguía en `due`, expuesto a corte y a que
 * le cobraran otra vez.
 */
const CAJA_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_CAJA_LIVE === 'true');
/**
 * Corte de arranque de la caja: sólo viajan los movimientos creados DESDE esta fecha.
 *
 * Abrir el gate no puede volcarle al legacy el historial que este sistema acumuló
 * mientras estuvo cerrado —hay pruebas de pantalla ahí dentro (un "Prueba" de 84.000
 * del 6 de agosto, sin aplicar a ninguna factura)— porque eso le mete plata inventada
 * a un libro que ya está cerrado y cuadrado. Lo que queda fuera se REPORTA, no se
 * esconde: si algo viejo hay que subirlo, se mueve la fecha a conciencia.
 */
const CAJA_DESDE = process.env.LEGACY_WRITEBACK_CAJA_DESDE
  ? new Date(process.env.LEGACY_WRITEBACK_CAJA_DESDE) : null;
/**
 * Gate SOLO para las EDICIONES hechas aquí sobre filas que nacieron en el legacy: la
 * ficha del abonado y la factura marcadas con `editedAt`.
 *
 * Es distinto de `UPDATES_LIVE` (el Modo B completo) y por eso puede abrirse ahora sin
 * romper la regla de oro: `UPDATES_LIVE` empuja el resultado de comparar TODAS las filas
 * campo a campo —la misma comparación que hace la ida en sentido contrario, así que las
 * dos se reescriben en bucle—, mientras que esto empuja únicamente lo que una persona
 * cambió a mano de este lado, y de eso la ida ya se aparta por `editedAt`. Empujado el
 * cambio, la fila queda igual en los dos lados y la siguiente pasada no ve nada que
 * hacer: el bucle no tiene de dónde arrancar.
 */
const EDITS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_EDICIONES_LIVE === 'true');
/**
 * Gate SOLO para el "servicio asignado": las columnas `television` / `combo` / `puntos`
 * de la factura.
 *
 * Allá el plan del abonado no vive en el cliente. La corrida mensual del legacy lo lee de
 * esas tres columnas de la ÚLTIMA factura recurrente (`Invoices_model.php:1130`), y por
 * eso su pantalla de editar factura tiene un bloque "ASIGNAR SERVICIO": es el sitio donde
 * se registra que alguien cambió de plan. Mientras el legacy siga facturando, cambiarle el
 * plan a un cliente aquí no se cobra allá si esas columnas no viajan.
 *
 * Va aparte de `EDITS_LIVE` a propósito, aunque las dos toquen `invoices`: aquélla borra y
 * reinserta TODOS los renglones de la factura, y asignarle un servicio a un cliente no
 * puede reescribirle una factura de 2024 entera. Ésta empuja tres columnas y nada más.
 *
 * Solo mira las facturas marcadas con `serviceAssignedAt` —las que una persona asignó a
 * mano de este lado—, así que no puede volcar al legacy el snapshot que bajó de él.
 */
const SERVICIO_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_SERVICIO_LIVE === 'true');
/**
 * Gate SOLO para el INVENTARIO: material, equipos y órdenes de compra.
 *
 * El inventario BAJA del legacy desde el 2026-08-25, pero no subía nada: lo que se movía
 * aquí —una devolución de equipo, el material que gasta un técnico en una visita, una
 * orden aprobada— allá no existía, y como la ida sí pisa lo que no lleva `editedAt`, el
 * movimiento tenía además fecha de caducidad. Con este gate el inventario deja de ser de
 * una sola dirección.
 *
 * Como en la caja, sube lo NUEVO y lo EDITADO aquí; y como en la caja, con corte de
 * fecha: abrir el gate no puede volcarle al legacy el inventario que este sistema
 * acumuló mientras estuvo cerrado.
 */
const INVENTARIO_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_INVENTARIO_LIVE === 'true');
const INVENTARIO_DESDE = process.env.LEGACY_WRITEBACK_INVENTARIO_DESDE
  ? new Date(process.env.LEGACY_WRITEBACK_INVENTARIO_DESDE) : null;
/**
 * Gate para PROPAGAR BORRADOS al legacy. Va aparte de todos los demás y CERRADO por
 * defecto, incluso con `LEGACY_WRITEBACK_LIVE=true`: es la única operación de todo el
 * writeback que destruye datos en el sistema que hoy manda, y un fallo aquí no se
 * arregla con otra pasada.
 *
 * Con el gate cerrado el paso NO es inútil: recorre las lápidas, comprueba una por una
 * si la fila se podría borrar allá y deja el plan escrito. Encenderlo es entonces una
 * decisión informada y no un salto al vacío.
 */
const BORRADOS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || process.env.LEGACY_WRITEBACK_BORRADOS_LIVE === 'true');
const dentroDelCorteInventario = (fecha) => !INVENTARIO_DESDE || (fecha && fecha >= INVENTARIO_DESDE);
/**
 * Gate SOLO para las ALTAS de la vertical de clientes: clientes nuevos, facturas
 * nuevas (+sus ítems) e historial de estados. NO abre los UPDATES — esos siguen
 * retenidos en Modo A, porque la ida restaura desde el legacy cada pasada y los dos
 * lados se pondrían a pisarse en un ping-pong sin fin.
 *
 * Se abrió el 2026-08-25, a petición de tener "los cambios visibles en los dos
 * sistemas": sin él, un cliente dado de alta aquí no existía allá, y por tanto
 * tampoco su factura ni su orden (`tickets.cid` es NOT NULL en el legacy), así que
 * la vertical entera se quedaba de este lado.
 */
const ALTAS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_ALTAS_LIVE === 'true');
/**
 * Corte de arranque de las altas — misma lección que dejó el gate de caja, y por el
 * mismo motivo: lo acumulado mientras la compuerta estuvo cerrada NO es histórico que
 * haya que volcar, son pruebas. Al abrir esto había 6 clientes esperando y los 6 eran
 * de ensayo ("PRUEBA · DEMO INSTALACIÓN", "PRUEBA CLIENTE CAPACITACIÓN", "ANUEL BRRR
 * TRAP"). Meterlos al legacy de producción es ensuciarle el maestro de abonados.
 *
 * Lo que queda fuera se REPORTA (`omitidosPorCorte`), no se esconde: si algo viejo
 * hay que subirlo, se mueve la fecha a conciencia.
 */
const ALTAS_DESDE = process.env.LEGACY_WRITEBACK_ALTAS_DESDE
  ? new Date(process.env.LEGACY_WRITEBACK_ALTAS_DESDE) : null;
/**
 * Gate SOLO para la RECONEXIÓN: que el legacy se entere de que un abonado que pagó
 * aquí volvió a tener servicio.
 *
 * Hasta el 2026-08-26 la plata sí viajaba (gate de caja) pero la reconexión no, y el
 * resultado era el peor de los dos mundos: el cliente navegando en la calle y las dos
 * pantallas diciendo "Cortado". Peor aún, la IDA del sync devuelve `usu_estado` cada
 * 15 min, así que la reconexión hecha aquí se BORRABA sola a los pocos minutos (35 de
 * las 37 primeras reconexiones automáticas acabaron así).
 *
 * Lo que se empuja es exactamente lo que hace el legacy cuando cobra su propia cajera
 * (`Transactions.php`, bloque "Reconexion"): `customers.usu_estado='Activo'` (con su
 * `ultimo_estado` y `fecha_cambio`) e `invoices.estado_tv` / `estado_combo` a NULL con
 * `ron='Activo'`. El historial de estados ya viaja aparte, por `pushEstados`.
 *
 * Dos candados, porque esto escribe sobre filas del legacy (que en Modo A es la fuente
 * de verdad):
 *  · sólo abonados cuya reconexión de AQUÍ es más NUEVA que el `fecha_cambio` de allá
 *    — si el legacy los volvió a cortar después, manda el legacy y no se toca nada;
 *  · sólo si allá están en un estado de CORTE (los mismos que reconectan aquí). A un
 *    Retirado o a un Suspendido no se le levanta el estado por un abono, y a un
 *    Compromiso se le levantan las FACTURAS pero no el estado: el acuerdo sigue vivo.
 * Es idempotente: cuando el legacy ya dice Activo no queda nada que empujar.
 */
const RECONEXION_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_RECONEXION_LIVE === 'true');
/** Hasta dónde atrás se miran reconexiones por empujar (las viejas ya no significan nada). */
const RECONEXION_DIAS = Number(process.env.LEGACY_WRITEBACK_RECONEXION_DIAS || 7);
/**
 * Estados del legacy sobre los que una reconexión sí manda (los reconectables de aquí).
 *
 * `Compromiso` NO está: al del acuerdo de pago se le devuelve el servicio, pero su
 * estado se queda como está — allá y aquí (ver `src/network/estado-al-reconectar.ts`).
 * Empujarlo a Activo borraba el acuerdo también en el legacy.
 */
const ESTADOS_CORTE_LEGACY = new Set(['Cortado', 'Cartera', 'Reportado']);

/**
 * Gate SOLO para las BAJAS: retiro y suspensión hechos aquí (cierre de una orden de
 * 'Retiro voluntario'/'Suspension …', cambio manual de estado en la ficha o devolución
 * de equipo).
 *
 * Es la cara opuesta del de reconexión y arregla el mismo agujero: hasta el 31-08-2026
 * el retiro se aplicaba —se cortaba el servicio y la ficha decía RETIRADO— pero el
 * legacy no se enteraba, y su `usu_estado='Activo'` volvía por la ida a los 15 minutos.
 * De los 7 retiros cerrados aquí desde el 25-08, 4 acabaron con el cliente otra vez
 * ACTIVO (3 abonados: 1192, 5168 y 56771).
 */
const BAJAS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_BAJAS_LIVE === 'true');
/** Hasta dónde atrás se miran bajas por empujar. */
const BAJAS_DIAS = Number(process.env.LEGACY_WRITEBACK_BAJAS_DIAS || 7);
/**
 * Gate SOLO para la ACTIVACIÓN por instalación: que el legacy se entere de que el
 * abonado que estaba 'Instalar' ya quedó instalado.
 *
 * Es el mismo agujero que taparon el de reconexión y el de bajas, en la tercera de las
 * tres puertas por las que se mueve el estado de un abonado. La cascada de cierre
 * (`applyCloseCascade`, rama 'instalac') deja el cliente ACTIVO aquí y `pushEstados` le
 * lleva al legacy la fila de `estados`… pero nadie le tocaba `customers.usu_estado`, que
 * es lo que la ida devuelve cada 15 minutos. Resultado: el técnico instalaba, cerraba la
 * orden, y el cliente volvía a 'INSTALAR' él solo. Nueve abonados así entre el 02 y el
 * 05-09-2026 (57442, 57443, 57444, 57445, 57446, 57448, 57449, 57450 y 57520); al 57443
 * hasta se lo pusieron a mano y también se deshizo.
 *
 * Se copia el bloque de 'Instalacion' del legacy (`Tickets.php`, línea 1302):
 * `ultimo_estado` = el estado que tenía, `fecha_cambio` y `usu_estado='Activo'`. El
 * historial (`estados`) ya lo empuja `pushEstados`, igual que en la reconexión.
 *
 * El candado es de una pieza y muy estrecho: SÓLO se escribe sobre abonados que en el
 * legacy están en **'Instalar'**. Ese estado no es operativo —no lo mueve la mora, ni la
 * cartera, ni un corte— y sólo significa "aún no instalado", así que no hay nada del
 * legacy que se pueda pisar. A un Cortado, un Cartera o un Retirado no se le levanta el
 * estado por cerrar una reinstalación. Y como en las hermanas: si el `fecha_cambio` de
 * allá es posterior a la instalación de aquí, manda el legacy.
 *
 * Es idempotente (cuando allá ya dice Activo no queda nada que empujar), así que una
 * pasada perdida se recupera sola en la siguiente.
 */
const ACTIVACION_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_ACTIVACION_LIVE === 'true');
/** Hasta dónde atrás se miran instalaciones por empujar. */
const ACTIVACION_DIAS = Number(process.env.LEGACY_WRITEBACK_ACTIVACION_DIAS || 7);
/** El único estado del legacy sobre el que una instalación cerrada aquí manda. */
const ESTADO_POR_INSTALAR_LEGACY = 'Instalar';
/**
 * Trabajos del legacy que dejan al abonado INSTALADO y que allá NO lo reactivan.
 *
 * `detalle` EXACTO (el `IN` de la consulta), no un LIKE: son los trabajos que sacan
 * al cliente a 'Instalar' para que salga la visita, y sólo la 'Instalacion' tiene
 * bloque de activación en `Tickets.php`. Los demás se cierran y el abonado se queda
 * ahí colgado, sin servicio que cobrar aunque esté navegando. 'Autenticacion' NO está
 * a propósito: autenticar una ONU también pasa en una reconexión, y ése no es un
 * trabajo que por sí solo diga que alguien quedó instalado.
 *
 * Los cinco son los mismos que reconoce `esTrabajoDeConexion` en el backend
 * (`support/order-types.ts`), escritos aquí como los escribe el legacy. El candado
 * de la función —sólo se toca a quien allá sigue en 'Instalar' y sólo si la orden se
 * cerró dentro de la ventana— es lo que hace seguro tener 'Traslado' y 'Cambio de
 * equipo' en la lista: si el cliente está en cualquier otro estado, no se le toca.
 */
const TRABAJOS_QUE_INSTALAN = [
  'Instalacion', 'Reinstalación', 'AgregarInternet', 'Migracion', 'Traslado', 'Cambio de equipo',
];

/** Bajas del legacy que una suspensión de aquí NO puede rebajar. */
const ESTADOS_BAJA_LEGACY = new Set(['Retirado', 'Depurado', 'Anulado', 'Dado de Baja', 'Suspendido']);
/** …y las que no se tocan ni para retirar: de ahí ya no se vuelve. */
const BAJAS_IRREVERSIBLES_LEGACY = new Set(['Depurado', 'Anulado', 'Dado de Baja']);

/**
 * ── Promociones del PORTAL DE PAGOS EN LÍNEA (vestel.com.co/crm) ───────────────
 *
 * El portal descuenta leyendo la tabla `promos` del legacy: busca la fila vigente HOY
 * para el ESTADO del cliente (`Customers_model::validar_promocion_estado_cus`) y, si
 * no encuentra ninguna, aplica un porcentaje QUEMADO en el PHP
 * (`Servicio::aplicar_discount`, el `else` que hoy está en 5%). Por eso este paso no
 * sólo publica lo que se decide aquí: deja SIEMPRE una fila por estado — la de la
 * promoción que lo alcanza, o una al 0% si no lo alcanza ninguna. Así el `else` nunca
 * se ejecuta y el descuento del portal pasa a mandarlo este sistema.
 *
 * Regla que no se puede romper: UNA sola fila vigente por estado. El PHP se queda con
 * `$promo_estado[0]` de una consulta sin ORDER BY; con dos filas vigentes, qué
 * porcentaje se aplica sería cosa del azar.
 */
const PROMOS_LIVE = !process.argv.includes('--dry')
  && (TARGET === 'copy' || LIVE_GATE || process.env.LEGACY_WRITEBACK_PROMOS_LIVE === 'true');
/** Marca de propiedad: en `promos`, las filas que empiezan así las manda nexus. */
const PROMOS_PREFIJO = '[nexus]';
/**
 * Poner en `false` para publicar las promociones pero NO tapar con 0% los estados que
 * no alcanzan — es decir, dejando que el portal siga regalando su porcentaje quemado.
 * Está por defecto en `true` porque ese regalo es justo lo que se vino a cerrar.
 */
const PROMOS_CANDADO = process.env.LEGACY_WRITEBACK_PROMOS_CANDADO !== 'false';
/**
 * Cuántos días dura la fila candado antes de renovarse. Es corta a propósito: si el
 * writeback deja de correr, caduca sola y el portal vuelve a su comportamiento de
 * siempre en vez de quedarse con un 0% eterno que nadie está vigilando.
 */
const PROMOS_CANDADO_DIAS = Number(process.env.LEGACY_WRITEBACK_PROMOS_CANDADO_DIAS || 30);
/**
 * `--solo=promos` — pasada MÍNIMA: sólo la tabla `promos`. Es la de mirar el plan
 * («qué le voy a dejar al portal») sin arrastrar la pasada entera, y la que se puede
 * disparar en cuanto se crea la campaña sin esperar los 15 minutos.
 */
const SOLO_PROMOS = arg('solo') === 'promos';

/** ¿Esta fila nació después del corte de altas? Sin corte configurado, pasan todas. */
const dentroDelCorteAltas = (createdAt) => !ALTAS_DESDE || (createdAt && createdAt >= ALTAS_DESDE);
const isoCorteAltas = () => (ALTAS_DESDE ? ALTAS_DESDE.toISOString().slice(0, 10) : '—');

/**
 * `--solo=caja` — pasada CORTA: sólo movimientos, recibos, anulaciones y comprobantes.
 *
 * Existe para poder empujar al legacy **en el instante** en que se cobra, sin pagar el
 * precio de la pasada completa: `pushCustomerUpdates` relee las 22.000 filas de
 * `customers` y `pushInvoiceUpdates` las 470.000 de `invoices` contra las 454.000 de
 * aquí — 25 segundos. Eso está bien cada 5 minutos y es inviable por cada pago.
 * La corta tarda ~1 s, que es lo que separa "se ve al momento" de "se ve luego".
 */
const SOLO_CAJA = arg('solo') === 'caja';
/**
 * `--solo=aperturas` — pasada MÍNIMA: sólo la apertura de caja del día. Es la que
 * dispara el propio botón de abrir (no hay plata que empujar todavía) y la única que
 * se puede probar contra `--target=copy` sin riesgo, porque no toca ni una fila de PG:
 * la pasada de caja sí enlaza `legacyId` y los de la BD de ensayo no valen aquí.
 */
const SOLO_APERTURAS = arg('solo') === 'aperturas';
/**
 * `--solo=reconexion` — pasada MÍNIMA: sólo la reconexión. Igual de barata que la de
 * caja y por el mismo motivo: tiene que llegar al legacy ANTES de la siguiente pasada
 * de la ida (cada 15 min), que si no devuelve el 'Cortado' y deshace el trabajo.
 */
const SOLO_RECONEXION = arg('solo') === 'reconexion';
/**
 * `--solo=borrados`: recorre únicamente las lápidas. Sirve para revisar el plan de
 * borrado —o para aplicarlo— sin arrastrar la pasada entera, que en `--target=copy`
 * escribiría en Postgres los `legacyId` de la base de ensayo.
 */
const SOLO_BORRADOS = arg('solo') === 'borrados';
/**
 * `--solo=bajas` — pasada MÍNIMA: sólo el retiro/suspensión. La dispara el propio
 * cierre de la orden, por lo mismo que la de reconexión: tiene que llegar al legacy
 * antes que la siguiente ida (15 min), que si no devuelve el 'Activo' y deshace el
 * retiro.
 */
const SOLO_BAJAS = arg('solo') === 'bajas';
/**
 * `--solo=estado-servicio` — pasada MÍNIMA: sólo el corte por servicio de la factura
 * (`estado_tv`/`estado_combo`). La dispara el cambio manual desde la ficha, por lo mismo
 * que las otras cortas: la ida vuelve a traer esas columnas cada 15 minutos.
 */
const SOLO_ESTADO_SERVICIO = arg('solo') === 'estado-servicio';
/**
 * `--solo=activacion` — pasada MÍNIMA: sólo la activación por instalación. La dispara
 * el cierre de la orden, por lo mismo que la de reconexión y la de bajas: si no llega
 * al legacy antes de la siguiente ida (15 min), vuelve el 'Instalar' y el cliente que
 * ya está instalado y navegando sigue saliendo "por instalar" en las dos pantallas.
 */
const SOLO_ACTIVACION = arg('solo') === 'activacion';
/**
 * `--solo=ordenes` — pasada MÍNIMA: sólo las órdenes de servicio. Es la que dispara el
 * backend en cuanto se crea o se reasigna una orden, por lo mismo que la de caja: el
 * técnico trabaja EN el legacy, y una orden que tarda cinco minutos en aparecerle es una
 * visita que no sale. De paso encoge a segundos la ventana en la que el legacy puede
 * repartir el mismo consecutivo (ver `nextLegacyTicketCode`).
 */
const SOLO_ORDENES = arg('solo') === 'ordenes';
/**
 * `--limite=N` — tope de órdenes a insertar en esta pasada. Es para la PRIMERA corrida
 * después de un atasco: empujar tres, ir a mirarlas al legacy y sólo entonces soltar el
 * resto. Sin él, el desatasco de 114 órdenes se comprueba cuando ya está hecho.
 */
const LIMITE = Number(arg('limite') || 0) || Infinity;


const UPDATES_LIVE = !DRY && (TARGET === 'copy' || !MODE_A);

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: TARGET === 'copy'
    ? (process.env.LEGACY_WRITEBACK_TEST_DB || 'writeback_test')
    : (process.env.LEGACY_DB_NAME || 'admin_vestel'),
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};
const STATE_KEY = 'legacySync.state';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const {
  mapCustomer, diffKeys,
  invCustomer, CUSTOMER_FIELD2COLS, invInvoice, invItem, invTx, invTicket, sameVal,
  invMaterial, invEquipo, invOrden, invOrdenItem,
  inv, RON_INV, INV_STATUS_INV, SVC_STATUS_INV, SUB_STATUS_INV, toD, toDT, num, norm,
  notaConComprobante, tieneComprobante,
} = require('./lib/vestel-map');

// ---------- helpers MySQL ----------
async function insertRow(my, table, obj) {
  const cols = Object.keys(obj);
  const [r] = await my.execute(
    `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => obj[c] ?? null),
  );
  return r.insertId;
}
async function updateRow(my, table, idCol, id, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  await my.execute(
    `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\`=?`).join(',')} WHERE \`${idCol}\`=?`,
    [...cols.map((c) => obj[c] ?? null), id],
  );
}

// ---------- estado compartido con la ida ----------
async function loadState() {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } });
  try { return row?.value ? JSON.parse(row.value) : {}; } catch { return {}; }
}
async function saveState(patchWb) {
  if (DRY) return;
  // releer antes de guardar: la ida pudo tocar el estado mientras corríamos
  const st = await loadState();
  st.wb = { ...(st.wb ?? {}), ...patchWb };
  const value = JSON.stringify(st);
  await prisma.appSetting.upsert({ where: { key: STATE_KEY },
    update: { value, group: 'legacy', updatedBy: 'writeback-legacy' },
    create: { key: STATE_KEY, value, group: 'legacy', updatedBy: 'writeback-legacy' } });
}

// ---------- pasos ----------
async function pushCustomers(my, sum) {
  const todos = await prisma.subscriber.findMany({
    where: { legacyId: null }, include: { branch: { select: { legacyId: true } } },
  });
  const rows = todos.filter((s) => dentroDelCorteAltas(s.createdAt));
  const fuera = todos.length - rows.length;
  sum.customers = { insertados: rows.length, omitidosPorCorte: fuera };
  if (fuera) log(`customers: ${fuera} anteriores al corte ${isoCorteAltas()} — NO viajan`);
  if (!ALTAS_LIVE) {
    if (rows.length) log(`customers: ${rows.length} ${DRY ? 'en plan (seco)' : 'RETENIDOS (gate de altas cerrado)'}`);
    return;
  }
  for (const s of rows) {
    const id = await insertRow(my, 'customers', invCustomer(s, s.branch?.legacyId ?? null));
    await prisma.subscriber.update({ where: { id: s.id }, data: { legacyId: id } });
  }
  if (rows.length) log(`customers: +${rows.length} empujados al legacy`);
}

async function pushCustomerUpdates(my, sum) {
  const [rows] = await my.query('SELECT * FROM customers');
  const pgRows = await prisma.subscriber.findMany({ where: { legacyId: { not: null } } });
  const myById = new Map(rows.map((r) => [r.id, r]));
  const cambios = [];
  for (const pg of pgRows) {
    const r = myById.get(pg.legacyId);
    if (!r) continue; // aún no existe allá (lo cubre pushCustomers en la próxima)
    const keys = diffKeys(mapCustomer(r), pg).filter((k) => CUSTOMER_FIELD2COLS[k]);
    if (keys.length) cambios.push({ pg, keys });
  }
  sum.customersUpd = { pendientes: cambios.length, aplicados: 0 };
  if (!UPDATES_LIVE) {
    if (cambios.length) log(`customers-upd: ${cambios.length} cambios ${DRY ? 'en plan (seco)' : 'RETENIDOS (modo legacy-activo)'}`);
    return;
  }
  for (const c of cambios) {
    const full = invCustomer(c.pg, null);
    const setObj = {};
    for (const k of c.keys) for (const col of CUSTOMER_FIELD2COLS[k]) setObj[col] = full[col];
    await updateRow(my, 'customers', 'id', c.pg.legacyId, setObj);
  }
  sum.customersUpd.aplicados = cambios.length;
}

/**
 * FICHAS DE ABONADO EDITADAS AQUÍ → legacy.
 *
 * Hermana de `pushEditedInvoices` y con la misma forma: entran sólo las filas marcadas
 * con `editedAt` (alguien corrigió el perfil en este sistema) y se escriben allá sólo
 * las columnas de PERFIL. El estado y los saldos no se tocan nunca: mientras convivan
 * los dos sistemas los mueve el legacy, y son justamente los campos que la ida sigue
 * aceptando en una ficha blindada (`CAMPOS_DE_ALLA` en `sync-legacy-vivo.js`). Las dos
 * listas son complementarias a propósito: lo que manda uno no lo escribe el otro.
 *
 * Sin estado que guardar: se compara contra lo que hay allá y se empuja la diferencia,
 * así que en cuanto el legacy queda igual la pasada siguiente no encuentra nada.
 */
const CAMPOS_QUE_MANDA_EL_LEGACY = new Set([
  'status', 'previousStatus', 'statusChangedAt', 'statusGenDate',
  'balance', 'debitCache', 'creditCache',
]);

async function pushCustomerEdits(my, sum) {
  const editadas = await prisma.subscriber.findMany({
    where: { editedAt: { not: null }, legacyId: { not: null } },
  });
  sum.customersEdit = { editadas: editadas.length, pendientes: 0, aplicados: 0, sinFilaEnLegacy: 0 };
  if (!editadas.length) return;

  const ids = editadas.map((r) => r.legacyId);
  const [filas] = await my.query('SELECT * FROM customers WHERE id IN (?)', [ids]);
  const myById = new Map(filas.map((r) => [r.id, r]));

  const cambios = [], yaIguales = [];
  for (const pg of editadas) {
    const r = myById.get(pg.legacyId);
    if (!r) { sum.customersEdit.sinFilaEnLegacy++; continue; }
    // `diffKeys(legacy, nuestro)` da los campos en los que los dos lados difieren; de
    // esos se empujan los de perfil, que son los que la ida ya no va a devolver.
    const keys = diffKeys(mapCustomer(r), pg)
      .filter((k) => CUSTOMER_FIELD2COLS[k] && !CAMPOS_QUE_MANDA_EL_LEGACY.has(k));
    if (keys.length) cambios.push({ pg, keys });
    // Sellada pero ya idéntica allá: nada que llevar, y el sello estorba.
    else if (EDITS_LIVE) yaIguales.push(pg.id);
  }
  sum.customersEdit.pendientes = cambios.length;
  if (yaIguales.length) {
    await prisma.subscriber.updateMany({ where: { id: { in: yaIguales } }, data: { editedAt: null } });
    sum.customersEdit.selloSoltado = yaIguales.length;
  }
  if (!EDITS_LIVE) {
    if (cambios.length) log(`customers-edit: ${cambios.length} fichas ${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de ediciones cerrado)'}`);
    return;
  }
  for (const c of cambios) {
    const full = invCustomer(c.pg, null);
    const setObj = {};
    for (const k of c.keys) for (const col of CUSTOMER_FIELD2COLS[k]) setObj[col] = full[col];
    await updateRow(my, 'customers', 'id', c.pg.legacyId, setObj);
    // Entregado: se suelta el blindaje. Los dos lados ya dicen lo mismo, así que la ida
    // no tiene nada que pisar, y la ficha vuelve a aceptar lo que corrijan allá.
    await prisma.subscriber.update({ where: { id: c.pg.id }, data: { editedAt: null } });
  }
  sum.customersEdit.aplicados = cambios.length;
  if (cambios.length) log(`customers-edit: ${cambios.length} fichas reescritas en el legacy`);
}

/**
 * Nº de factura libre en el legacy, de SU contador y bajo un candado.
 *
 * Misma historia que el nº de orden (ver `nextLegacyTicketCode`, con el relato largo):
 * el legacy numera con `MAX(tid)+1` y el rango partido de nexus —desde 500.000— duró
 * hasta el primer empuje. Al recibir nuestras facturas 500.002-500.026 tomó ese máximo
 * como suyo y el 2026-08-28 emitió SU factura 470663 con tid 500027, el mismo que
 * acababa de repartir nuestra secuencia: dos facturas distintas con el mismo número, la
 * suya sin poder bajar por el índice único y su pago colgando de la nuestra.
 *
 * Así que mientras el legacy siga facturando, el número lo reparte el legacy y aquí se
 * renumera. La secuencia de nexus se subió a 900.000 (migración `tid_seq_900k`) para que
 * lo que todavía no ha viajado tampoco pueda chocar con lo que él mine entre tanto.
 *
 * `GET_LOCK` es el candado que él no se pone —dos cajeras suyas simultáneas SÍ pueden
 * sacar el mismo tid, fallo suyo de siempre— y que aquí hace falta porque la corrida
 * del mes empuja miles de facturas seguidas.
 */
async function nextLegacyInvoiceTid(my) {
  const [[{ n }]] = await my.query("SELECT GET_LOCK('nexus_invoice_tid', 10) AS n");
  if (!n) throw new Error('no se pudo tomar el candado del consecutivo de facturas en el legacy');
  try {
    const [[row]] = await my.query('SELECT COALESCE(MAX(tid), 0) + 1 AS siguiente FROM invoices');
    return Number(row.siguiente);
  } finally {
    await my.query("SELECT RELEASE_LOCK('nexus_invoice_tid')");
  }
}

/**
 * Renumera una factura de ESTE lado al tid que le tocó en el legacy.
 *
 * `tid` no es una clave técnica: es el número que sale en el recibo, por el que
 * pregunta el cliente y con el que el legacy engancha los pagos. Cuelga de él el
 * asiento contable, que lo lleva en el texto y en la referencia (`Factura de venta N`),
 * y se mueve por `sourceId` —el id de la factura, que no cambia— y no por el número
 * viejo: buscar por número engancharía el asiento de otra factura que lo tuviera.
 *
 * Y cuelga de él la ORDEN que la emitió: `Ticket.chargeInvoiceTid` (y `moveInvoiceTid`
 * en los traslados) guardan el NÚMERO, no el id, porque es lo que se enseña en la
 * tarjeta de la orden y lo que viaja al legacy. Sin renumerarlos también, la orden se
 * queda apuntando a una factura que ya no existe —pasó con nueve órdenes de
 * septiembre— y con ella se pierde el único rastro de que ese trabajo ya está cobrado.
 */
async function renumerarFactura(f, nuevo) {
  if (f.tid === nuevo) return;
  await prisma.$transaction(async (tx) => {
    await tx.subInvoice.update({ where: { id: f.id }, data: { tid: nuevo } });
    await tx.journalEntry.updateMany({
      where: { sourceType: 'SALES_INVOICE', sourceId: f.id },
      data: { reference: String(nuevo), description: `Factura de venta ${nuevo}` },
    });
    await tx.ticket.updateMany({ where: { chargeInvoiceTid: f.tid }, data: { chargeInvoiceTid: nuevo } });
    await tx.ticket.updateMany({ where: { moveInvoiceTid: f.tid }, data: { moveInvoiceTid: nuevo } });
  });
}

async function pushInvoices(my, sum) {
  const todas = await prisma.subInvoice.findMany({
    where: { legacyId: null },
    include: { subscriber: { select: { legacyId: true } }, items: true },
    orderBy: { tid: 'asc' },
  });
  const rows = todas.filter((f) => dentroDelCorteAltas(f.createdAt));
  const fuera = todas.length - rows.length;
  if (fuera) log(`invoices: ${fuera} anteriores al corte ${isoCorteAltas()} — NO viajan`);
  const renumeradas = [], sinCliente = [];
  let ins = 0, items = 0;
  for (const f of rows) {
    const csd = f.subscriber?.legacyId;
    if (!csd) { sinCliente.push(f.tid); continue; }
    ins++; items += f.items.length;
    if (!ALTAS_LIVE) continue;
    // El número lo pone el legacy SIEMPRE, no sólo cuando choca: si le empujamos el
    // nuestro, su MAX(tid)+1 se muda a nuestro rango y a la siguiente factura suya
    // volvemos a chocar. Ver `nextLegacyInvoiceTid`.
    const tid = await nextLegacyInvoiceTid(my);
    const id = await insertRow(my, 'invoices', invInvoice({ ...f, tid }, csd));
    await prisma.subInvoice.update({ where: { id: f.id }, data: { legacyId: id } });
    if (tid !== f.tid) { renumeradas.push({ antes: f.tid, ahora: tid }); await renumerarFactura(f, tid); }
    for (const it of f.items) {
      const itemId = await insertRow(my, 'invoice_items', invItem(it, tid));
      await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: itemId } });
    }
  }
  sum.invoices = { insertadas: ins, items, renumeradas, sinCliente: sinCliente.length, omitidasPorCorte: fuera };
  if (!ALTAS_LIVE && ins) log(`invoices: ${ins} ${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de altas cerrado)'}`);
  if (renumeradas.length) {
    log(`invoices: ${renumeradas.length} renumeradas con el consecutivo del legacy`
      + ` (${renumeradas.slice(0, 5).map((r) => `${r.antes}→${r.ahora}`).join(', ')})`);
  }
}

/** Ítems del stack nuevo sobre facturas de origen legacy (p.ej. notas crédito). */
async function pushItems(my, sum) {
  const rows = await prisma.subInvoiceItem.findMany({
    // Las facturas EDITADAS aquí van por `pushEditedInvoices`: allá hay que borrar y
    // reinsertar el juego completo de renglones. Insertar sólo los nuevos dejaría la
    // factura del legacy con los viejos MÁS los nuevos y el detalle no daría el total.
    where: { legacyId: null, invoice: { legacyId: { not: null }, editedAt: null } },
    include: { invoice: { select: { tid: true } } },
  });
  const dentro = rows.filter((it) => dentroDelCorteAltas(it.createdAt));
  sum.items = { insertados: dentro.length, omitidosPorCorte: rows.length - dentro.length };
  if (!ALTAS_LIVE) return;
  for (const it of dentro) {
    const id = await insertRow(my, 'invoice_items', invItem(it, it.invoice.tid));
    await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: id } });
  }
}

/**
 * Facturas EDITADAS en el stack nuevo → se reescriben en el legacy tal como lo hace
 * su propio "Editar factura" (`Invoices::editaction`): borra los renglones de la
 * factura y reinserta los que hay ahora, y actualiza los totales del encabezado.
 *
 * Sólo corre en modo B (el nuevo activo): mientras el legacy sea el sistema vivo,
 * la edición se queda de este lado y la ida la respeta por `editedAt`.
 * `st.wb.editsPushed` guarda qué número de edición se empujó por factura, para no
 * reescribir en cada pasada lo que ya está igual allá.
 */
async function pushEditedInvoices(my, st, sum) {
  const rows = await prisma.subInvoice.findMany({
    where: { editedAt: { not: null }, legacyId: { not: null } },
    include: { subscriber: { select: { legacyId: true } }, items: true },
  });
  const pushed = st.wb?.editsPushed ?? {};
  // La huella lleva `editedAt` y no sólo `editCount`: una NOTA (crédito o débito) mueve
  // el total y sella `editedAt`, pero NO toca `editCount` —eso cuenta ediciones—. Con
  // sólo el contador, la primera nota viajaba y la segunda no: el descuento bajaba el
  // total allá y la reversión, que vale lo mismo en sentido contrario, se quedaba aquí.
  const huella = (f) => `${f.editCount}:${f.editedAt?.getTime() ?? 0}`;
  const pend = rows.filter((f) => pushed[f.legacyId] !== huella(f));
  sum.invoicesEdit = { pendientes: pend.length, aplicados: 0 };
  if (!EDITS_LIVE) {
    if (pend.length) log(`invoices-edit: ${pend.length} ediciones ${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de ediciones cerrado)'}`);
    return;
  }
  const nuevo = { ...pushed };
  for (const f of pend) {
    await my.execute('DELETE FROM invoice_items WHERE tid = ?', [f.tid]);
    for (const it of f.items) {
      const id = await insertRow(my, 'invoice_items', invItem(it, f.tid));
      await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: id } });
    }
    // Sólo las columnas que mueve la edición: el cobro (status/pamnt) lo lleva
    // `pushInvoiceUpdates`, que compara la huella completa.
    const full = invInvoice(f, f.subscriber?.legacyId ?? null);
    const cols = ['subtotal', 'tax', 'total', 'items', 'invoicedate', 'invoiceduedate', 'notes', 'tipo_factura'];
    const setObj = {};
    for (const c of cols) setObj[c] = full[c];
    await updateRow(my, 'invoices', 'id', f.legacyId, setObj);
    nuevo[f.legacyId] = huella(f);
  }
  sum.invoicesEdit.aplicados = pend.length;
  await saveState({ editsPushed: nuevo });
  if (pend.length) log(`invoices-edit: ${pend.length} facturas reescritas en el legacy`);
}

/**
 * El "servicio asignado" hacia el legacy: `television`, `combo` y `puntos` de las
 * facturas donde alguien fijó a mano el plan del abonado (ver `SERVICIO_LIVE`).
 *
 * Empuja SOLO esas tres columnas y solo cuando difieren: es idempotente, no toca
 * renglones ni montos, y se auto-corrige si una pasada quedó a medias. No necesita
 * marca de agua en el estado por lo mismo — la comparación contra la fila real basta.
 *
 * El legacy guarda '' donde aquí puede haber null, así que se normaliza antes de
 * comparar; de lo contrario cada pasada vería una diferencia que no existe y
 * reescribiría las mismas filas para siempre.
 *
 * NULL AQUÍ NO ES UN 'no' ALLÁ: se empujan sólo las columnas que este lado sabe. La
 * marca la pone tanto quien asigna el servicio en la factura (que escribe las tres a
 * la vez) como quien QUITA un servicio del abonado (que escribe una sola, ver
 * `removeService`). Dando por 'no' lo que aquí está en null, quitarle la televisión a
 * un abonado con la cabecera en blanco le apagaba de paso el internet en el legacy:
 * pasó con la factura #505088 del abonado 56130 el 09-09-2026.
 */
async function pushServicioAsignado(my, sum) {
  const marcadas = await prisma.subInvoice.findMany({
    where: { serviceAssignedAt: { not: null }, legacyId: { not: null } },
    select: { legacyId: true, tid: true, serviceTv: true, serviceCombo: true, puntos: true },
  });
  sum.servicioAsignado = { marcadas: marcadas.length, pendientes: 0, aplicados: 0 };
  if (!marcadas.length) return;

  const ids = marcadas.map((f) => f.legacyId);
  const filas = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const trozo = ids.slice(i, i + 2000);
    const [rows] = await my.query(
      `SELECT id, television, combo, puntos FROM invoices WHERE id IN (${trozo.map(() => '?').join(',')})`, trozo);
    filas.push(...rows);
  }
  const porId = new Map(filas.map((r) => [r.id, r]));

  const cambios = [];
  for (const f of marcadas) {
    const r = porId.get(f.legacyId);
    if (!r) continue; // borrada allá: no se resucita desde aquí
    const want = {};
    if (f.serviceTv != null) want.television = f.serviceTv;
    if (f.serviceCombo != null) want.combo = f.serviceCombo;
    if (f.puntos != null) want.puntos = f.puntos;
    const difiere = ('television' in want && norm(r.television) !== want.television)
      || ('combo' in want && norm(r.combo) !== want.combo)
      || ('puntos' in want && Number(r.puntos ?? 0) !== Number(want.puntos));
    if (difiere) cambios.push({ id: f.legacyId, tid: f.tid, want });
  }
  sum.servicioAsignado.pendientes = cambios.length;
  if (!SERVICIO_LIVE) {
    if (cambios.length) log(`servicio: ${cambios.length} asignaciones ${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de servicio cerrado)'}`);
    return;
  }
  for (const c of cambios) await updateRow(my, 'invoices', 'id', c.id, c.want);
  sum.servicioAsignado.aplicados = cambios.length;
  if (cambios.length) {
    log(`servicio: ${cambios.length} facturas con el plan actualizado en el legacy (${cambios.slice(0, 5).map((c) => `#${c.tid} ${c.want.combo ?? '·'}/${c.want.television ?? '·'}`).join(', ')})`);
  }
}

/**
 * ESTADO DE SERVICIO movido AQUÍ (`estado_tv` / `estado_combo`) → legacy.
 *
 * Es el tercer pariente de `pushReconexiones` y `pushBajas`, y existe porque los dos
 * anteriores buscan a quién empujar por el ESTADO DEL ABONADO —la fila de historial, la
 * orden de reconexión— y hay bajas que no le cambian el estado a nadie: suspender sólo
 * la televisión deja al cliente ACTIVO (con su internet navegando) y mueve una sola
 * columna de su factura. Nadie se lo contaba al legacy, así que la ida devolvía el 'al
 * aire' a los quince minutos: la orden #502150 se cerró el 31-08-2026 y el abonado 57459
 * se quedó con la TV suspendida en la calle y activa en las dos pantallas.
 *
 * Se apoya en la marca `SubInvoice.serviceStatusAt`, que ponen tanto el cierre de la
 * orden (`marcarBajaEnFactura`) como el cambio manual desde la ficha
 * (`cambiarEstadoDeServicio`). Mientras la marca está puesta, la ida no pisa esas dos
 * columnas; en cuanto el legacy tiene el mismo valor, la marca SE BORRA y el legacy
 * vuelve a mandar sobre el corte —que es lo correcto: allá se corta por mora todos los
 * meses y eso tiene que seguir llegando—.
 *
 * Gates: no estrena interruptor. CORTAR o SUSPENDER es una baja (`BAJAS_LIVE`) y
 * LEVANTAR el corte es una reconexión (`RECONEXION_LIVE`); son las mismas dos columnas
 * que esos dos pasos ya escriben, y cada dirección respeta el gate que le toca.
 * Idempotente: sin diferencia contra la fila real no se escribe nada.
 */
async function pushEstadoServicio(my, sum) {
  const marcadas = await prisma.subInvoice.findMany({
    where: { serviceStatusAt: { not: null }, legacyId: { not: null } },
    select: {
      id: true, legacyId: true, tid: true, estadoTv: true, estadoCombo: true,
      subscriber: { select: { abonado: true } },
    },
  });
  sum.estadoServicio = { marcadas: marcadas.length, pendientes: 0, aplicados: 0, liberadas: 0, retenidas: 0 };
  if (!marcadas.length) return;

  const ids = marcadas.map((f) => f.legacyId);
  const filas = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const trozo = ids.slice(i, i + 2000);
    const [rows] = await my.query(
      `SELECT id, tid, estado_tv, estado_combo FROM invoices WHERE id IN (${trozo.map(() => '?').join(',')})`, trozo);
    filas.push(...rows);
  }
  const porId = new Map(filas.map((r) => [r.id, r]));
  // El legacy guarda '' donde aquí hay null: sin normalizar, cada pasada vería una
  // diferencia que no existe y reescribiría las mismas filas para siempre.
  const vacio = (v) => (norm(v) === '' ? null : norm(v));

  const cambios = [], alDia = [];
  let retenidas = 0;
  for (const f of marcadas) {
    const r = porId.get(f.legacyId);
    if (!r) continue; // borrada allá: no se resucita desde aquí
    const want = {
      estado_tv: inv(SVC_STATUS_INV)(f.estadoTv) ?? null,
      estado_combo: inv(SVC_STATUS_INV)(f.estadoCombo) ?? null,
    };
    const set = {};
    if (vacio(r.estado_tv) !== want.estado_tv) set.estado_tv = want.estado_tv;
    if (vacio(r.estado_combo) !== want.estado_combo) set.estado_combo = want.estado_combo;
    if (!Object.keys(set).length) { alDia.push(f); continue; } // el legacy ya está igual
    // Cada columna respeta el gate de SU dirección: poner un corte es una baja,
    // quitarlo es una reconexión. Lo que un gate retenga se queda pendiente para la
    // siguiente pasada, con su marca puesta (no se suelta lo que no se empujó).
    let frenado = false;
    for (const col of Object.keys(set)) {
      const abre = set[col] === null ? RECONEXION_LIVE : BAJAS_LIVE;
      if (!abre) { delete set[col]; frenado = true; }
    }
    if (frenado) retenidas += 1;
    cambios.push({
      id: f.legacyId, pgId: f.id, tid: f.tid, abonado: f.subscriber?.abonado ?? null,
      set, completo: !frenado,
    });
  }

  const porEscribir = cambios.filter((c) => Object.keys(c.set).length);
  sum.estadoServicio.pendientes = cambios.length;
  sum.estadoServicio.retenidas = retenidas;
  sum.estadoServicio.muestra = cambios.slice(0, 5).map((c) => ({ abonado: c.abonado, tid: c.tid, ...c.set }));

  // Manda el gate de cada dirección, no el `DRY` global: igual que `pushBajas` y
  // `pushReconexiones`, esto escribe aunque `LEGACY_WRITEBACK_LIVE` siga en false.
  if (porEscribir.length) {
    for (const c of porEscribir) await updateRow(my, 'invoices', 'id', c.id, c.set);
    sum.estadoServicio.aplicados = porEscribir.length;
  } else if (cambios.length) {
    log(`estado-servicio: ${cambios.length} facturas ${DRY && !BAJAS_LIVE && !RECONEXION_LIVE ? 'en plan (seco)' : 'RETENIDAS (gates de baja/reconexión cerrados)'}`);
  }

  // La marca se suelta cuando el legacy ya tiene lo mismo —lo acabemos de empujar o
  // porque allá ya estaba igual—: a partir de ahí el corte vuelve a mandarlo él, que es
  // lo que tiene que pasar (allá se corta por mora todos los meses). Lo que un gate
  // retuvo conserva su marca y se reintenta en la siguiente pasada.
  //
  // Va FUERA del `if` de arriba a propósito. Estaba dentro, después de un `return`
  // temprano, así que las facturas que YA coincidían con el legacy (`alDia`) sólo se
  // soltaban si en esa misma pasada había alguna otra que escribir: cuando no la había
  // —lo normal en cuanto se pone al día— la marca se quedaba puesta para siempre, y con
  // la marca puesta la ida deja de traer `estado_tv`/`estado_combo` de esa factura. O
  // sea: el corte por mora que el legacy le hiciera después a ese abonado ya no llegaba
  // aquí nunca.
  //
  // Nunca contra la base de ENSAYO: sus `legacyId` no son los de producción y soltaría
  // marcas que aquí no se han empujado de verdad. Ni en `--dry`, que no escribe nada en
  // ningún lado: soltar la marca ES una escritura.
  if (TARGET !== 'copy' && !process.argv.includes('--dry')) {
    const liberar = [...alDia.map((f) => f.id), ...porEscribir.filter((c) => c.completo).map((c) => c.pgId)];
    if (liberar.length) {
      await prisma.subInvoice.updateMany({ where: { id: { in: liberar } }, data: { serviceStatusAt: null } });
      sum.estadoServicio.liberadas = liberar.length;
    }
  }
  if (porEscribir.length) {
    log(`estado-servicio: ${porEscribir.length} facturas con el corte actualizado en el legacy`
      + ` (${porEscribir.slice(0, 5).map((c) => `#${c.tid} tv=${c.set.estado_tv ?? '—'} combo=${c.set.estado_combo ?? '—'}`).join(', ')})`);
  }
}

async function pushInvoiceUpdates(my, sum) {
  const [fpMy] = await my.query('SELECT id,status,pamnt,total,ron,estado_tv,estado_combo,rec,promo,promo2 FROM invoices');
  const myById = new Map(fpMy.map((r) => [r.id, r]));
  const fpPg = await prisma.subInvoice.findMany({ where: { legacyId: { not: null } },
    select: { legacyId: true, status: true, paidAmount: true, total: true, ron: true,
      estadoTv: true, estadoCombo: true, rec: true, promo: true, promo2: true } });
  const cambios = [];
  for (const pg of fpPg) {
    const r = myById.get(pg.legacyId);
    if (!r) continue;
    const want = {
      status: inv(INV_STATUS_INV)(pg.status) ?? 'due', pamnt: num(pg.paidAmount), total: num(pg.total),
      ron: inv(RON_INV)(pg.ron), estado_tv: inv(SVC_STATUS_INV)(pg.estadoTv),
      estado_combo: inv(SVC_STATUS_INV)(pg.estadoCombo), rec: pg.rec ?? '',
      promo: pg.promo, promo2: pg.promo2,
    };
    if (want.status !== r.status || want.pamnt !== num(r.pamnt) || want.total !== num(r.total)
      || (want.ron ?? null) !== (r.ron === '' ? null : r.ron) || (want.estado_tv ?? null) !== (r.estado_tv === '' ? null : r.estado_tv)
      || (want.estado_combo ?? null) !== (r.estado_combo === '' ? null : r.estado_combo)
      || String(want.rec ?? '') !== String(r.rec ?? '') || (want.promo ?? null) !== (r.promo ?? null)
      || (want.promo2 ?? null) !== (r.promo2 ?? null)) {
      cambios.push({ id: pg.legacyId, want });
    }
  }
  sum.invoicesUpd = { pendientes: cambios.length, aplicados: 0 };
  if (!UPDATES_LIVE) {
    if (cambios.length) log(`invoices-upd: ${cambios.length} cambios ${DRY ? 'en plan (seco)' : 'RETENIDOS (modo legacy-activo)'}`);
    return;
  }
  for (const c of cambios) await updateRow(my, 'invoices', 'id', c.id, c.want);
  sum.invoicesUpd.aplicados = cambios.length;
}

/**
 * ¿El legacy ya tiene ESTE mismo pago, anotado allá a mano?
 *
 * Mientras los dos sistemas convivan, la misma cajera puede registrar el pago en los
 * dos. Insertar a ciegas dejaría el pago DUPLICADO en el libro del legacy y ningún
 * cierre cuadraría. Se busca por factura + fecha + valor, que es lo que identifica un
 * pago de ventanilla (una factura se paga una vez; y si hay abonos, el valor los
 * distingue). Las anuladas no cuentan: adoptar una anulada sería dar por bueno un
 * movimiento que allá ya no vale.
 *
 * Sólo se hace con pagos DE FACTURA. Para egresos y transferencias no hay una llave
 * natural fiable —dos viáticos de 20.000 el mismo día son perfectamente posibles— y
 * ahí adoptar por parecido borraría plata real del libro; esos se insertan siempre.
 */
async function gemeloEnLegacy(my, t, tid) {
  if (!tid) return null;
  const [r] = await my.execute(
    `SELECT id FROM transactions
      WHERE tid = ? AND date = ? AND debit = ? AND credit = ?
        AND (estado IS NULL OR estado <> 'Anulada')
      LIMIT 1`,
    [tid, toD(t.date), Number(t.debit ?? 0), Number(t.credit ?? 0)],
  );
  return r[0]?.id ?? null;
}

/**
 * Deja el legacy como si el movimiento se hubiera registrado en su propia ventanilla.
 *
 * Insertar la fila en `transactions` mete la plata en el libro, pero allá un cobro
 * toca tres sitios más (Customers_model::hacer_pago): la FACTURA (`pamnt`/`status`),
 * el saldo corrido de la CAJA (`accounts.lastbal`, del que vive su informe de balance)
 * y el acumulado del CLIENTE (`customers.debit/credit`). Sin esto el dinero entra pero
 * la factura sigue en `due`: el abonado que ya pagó se ve moroso allá, expuesto a
 * corte y a que le cobren otra vez — justo el problema que se vino a resolver.
 *
 * La factura se recalcula CONTRA EL LEGACY, no se copia de aquí. En Modo A la ida
 * restaura el estado de las facturas desde allá cada 15 minutos, así que para cuando
 * corre el writeback este sistema ya puede tener el pago revertido (pasó: cuatro
 * pagos del 24-08 estaban en `DUE` aquí y en `due` allá, con la plata ya cobrada).
 * Recalcular lo hace además idempotente: repetir la corrida no infla nada.
 *
 * `lastbal` sí es incremental —es un saldo corrido, no un agregado— y por eso se toca
 * UNA sola vez, justo detrás del INSERT que lo justifica.
 */
async function reflejarEnLegacy(my, t, tid) {
  const credit = Number(t.credit ?? 0);
  const debit = Number(t.debit ?? 0);

  // 1) Saldo corrido de la caja: el ingreso suma, el egreso resta (igual que allá).
  if (t.cashAccountId) {
    await my.execute('UPDATE accounts SET lastbal = lastbal + ? WHERE id = ?', [credit - debit, t.cashAccountId]);
  }

  // 2) Acumulado del cliente, con el mismo criterio que `money_details()` del legacy:
  //    sólo movimientos vigentes y de venta (`ext = '0'`).
  const payerid = t.subscriber?.legacyId ?? 0;
  if (payerid) {
    await my.execute(
      `UPDATE customers SET
         debit  = (SELECT COALESCE(SUM(debit), 0)  FROM transactions WHERE payerid = ? AND estado IS NULL AND ext = '0'),
         credit = (SELECT COALESCE(SUM(credit), 0) FROM transactions WHERE payerid = ? AND estado IS NULL AND ext = '0')
       WHERE id = ?`,
      [payerid, payerid, payerid],
    );
  }

  // 3) La factura, recalculada desde los movimientos que hay AHORA en el legacy.
  if (!tid) return false;
  const [[f]] = await my.query('SELECT id, total FROM invoices WHERE tid = ? LIMIT 1', [tid]);
  if (!f) return false;
  const [[s]] = await my.query(
    `SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS pagado
       FROM transactions WHERE tid = ? AND (estado IS NULL OR estado = '')`, [tid]);
  const pagado = Number(s.pagado);
  const total = Number(f.total);
  await updateRow(my, 'invoices', 'id', f.id, {
    pamnt: pagado,
    status: pagado <= 0 ? 'due' : (pagado >= total ? 'paid' : 'partial'),
    pmethod: t.method ?? '',
  });
  return true;
}

/**
 * Movimientos de caja creados aquí → `transactions` del legacy.
 *
 * Dos cuidados que no son opcionales:
 *  · ADOPTAR antes que insertar (ver `gemeloEnLegacy`), para no duplicar la plata.
 *  · No referenciar facturas que allá no existen: las nacidas aquí van en otro rango
 *    de `tid` (ver common/tid.ts) y el legacy no las tiene. Ese movimiento se empuja
 *    con `tid = 0` y el número de factura queda dicho en la nota, para que la plata
 *    entre al libro sin dejar una referencia colgando.
 */
/**
 * APERTURA DE CAJA — la pieza que no viajaba y por la que una cajera podía tener la
 * caja abierta aquí y cerrada allá el mismo día (reportado el 2026-08-26: Mireya abrió
 * en SAVES a las 7:44 y en el legacy seguía con la apertura del día anterior).
 *
 * No es un dato compartido, son dos cosas distintas con el mismo nombre:
 *   · aquí   → una fila `CashOpen` por CAJA y día, con la base (fondo fijo + arrastre).
 *   · allá   → un PERMISO por USUARIO: `permisos_usuario.is_checked = 0` en los módulos
 *              3 (`conue`, Nueva Factura) y 5 (`cocie`, Cierre) + `finicial`/`hinicial`
 *              en `aauth_users`. Cerrar = volver esos permisos a NULL.
 * Por eso no hay `legacyId` que enlazar: el puente es el USUARIO que abrió, y se
 * resuelve por nombre contra `Staff.legacyId` (= `aauth_users.id`).
 *
 * Sólo se empujan las aperturas de HOY: allá la apertura vale su día y sola caduca al
 * primer page-load del siguiente. Reflejar una de ayer no abriría nada, sólo mentiría
 * en el historial.
 *
 * La hora se escribe en hora de COLOMBIA, no la del servidor (MySQL corre en Europe/
 * Berlin y el legacy estampa siempre local: sus filas de hoy dicen 7:45 am).
 */
// Los formatos viven en `lib/hora-co` porque la IDA los relee: el sync convierte esos
// mismos `finicial`/`hinicial` en la apertura de este lado (`syncAperturas`). Dos copias
// de la conversión serían dos relojes, y con ellos una apertura que nunca casa.
const { HORA_CO, FECHA_CO, HORA_CO_AMPM, HORA_CO_SEG } = require('./lib/hora-co');

/** Usuario del legacy que corresponde al nombre con el que se firmó la apertura. */
async function usuarioLegacyDe(nombre) {
  if (!nombre) return null;
  const staff = await prisma.staff.findFirst({
    where: { legacyId: { not: null }, banned: false, name: { equals: nombre.trim(), mode: 'insensitive' } },
    select: { legacyId: true, name: true, username: true },
  });
  if (staff) return staff;
  // Segundo intento por correo: el nombre en `User` puede no coincidir letra a letra
  // con el de `Staff` (el vínculo entre los dos es el email).
  const u = await prisma.user.findFirst({ where: { name: nombre }, select: { email: true } });
  if (!u?.email) return null;
  return prisma.staff.findFirst({
    where: { legacyId: { not: null }, banned: false, email: { equals: u.email, mode: 'insensitive' } },
    select: { legacyId: true, name: true, username: true },
  });
}

async function pushCashOpens(my, sum) {
  const hoy = FECHA_CO(new Date());
  const rows = await prisma.cashOpen.findMany({
    where: { date: new Date(`${hoy}T00:00:00.000Z`) },
    orderBy: { openedAt: 'asc' },
  });
  sum.aperturas = {
    hoy: rows.length, abiertas: 0, yaAbiertas: 0, sinUsuarioEnLegacy: [], abiertasSoloEnLegacy: [],
  };

  // El otro lado de la deriva: quién tiene la caja abierta ALLÁ y no aquí. Sólo se
  // informa —crear la apertura de este lado es trabajo de la ida, no del writeback—,
  // pero sin esta línea el desajuste vuelve a vivir sin que nada lo grite.
  const [abiertosAllá] = await my.query(
    'SELECT id, username, hinicial FROM aauth_users WHERE finicial = ? ORDER BY hinicial', [hoy],
  );
  const míosHoy = new Set();
  for (const o of rows) {
    const staff = await usuarioLegacyDe(o.openedBy);
    if (!staff) {
      sum.aperturas.sinUsuarioEnLegacy.push({ caja: o.cashAccountId, abrió: o.openedBy });
      log(`aperturas: "${o.openedBy}" (caja ${o.cashAccountId}) no casa con ningún usuario del legacy`);
      continue;
    }
    míosHoy.add(staff.legacyId);
    const [[allá]] = await my.query(
      'SELECT id, finicial, hinicial, banned FROM aauth_users WHERE id = ?', [staff.legacyId],
    );
    if (!allá) {
      sum.aperturas.sinUsuarioEnLegacy.push({ caja: o.cashAccountId, abrió: o.openedBy, id: staff.legacyId });
      continue;
    }
    if (allá.finicial === hoy) { sum.aperturas.yaAbiertas++; continue; }

    const hora = HORA_CO(o.openedAt);
    if (!CAJA_LIVE) {
      log(`aperturas: ${staff.username} (caja ${o.cashAccountId}) ${DRY ? 'en plan' : 'RETENIDA'} → finicial ${hoy} ${hora}`);
      continue;
    }
    // Las tres escrituras de `Invoices/activar`, en su mismo orden.
    await my.execute('UPDATE aauth_users SET finicial = ?, hinicial = ? WHERE id = ?', [hoy, hora, staff.legacyId]);
    for (const modulo of [3, 5]) {
      const [r] = await my.execute(
        'UPDATE permisos_usuario SET is_checked = 0 WHERE id_usuario = ? AND id_modulo = ?',
        [staff.legacyId, modulo],
      );
      // Un usuario sin la fila del módulo no tendría el menú aunque abriera.
      if (!r.affectedRows) {
        await insertRow(my, 'permisos_usuario', { id_modulo: modulo, id_usuario: staff.legacyId, is_checked: 0 });
      }
    }
    await insertRow(my, 'historial_crm', {
      modulo: 'Ventas', accion: 'Apertura de caja {update}', id_usuario: String(staff.legacyId),
      fecha: `${hoy} ${HORA_CO_SEG(new Date())}`,
      descripcion: JSON.stringify({ finicial: `${hoy} 00:00:00`, hinicial: HORA_CO_AMPM(o.openedAt), origen: 'SAVES' }),
      id_fila: staff.legacyId, tabla: 'aauth_users', nombre_columna: 'id',
    });
    sum.aperturas.abiertas++;
    log(`aperturas: caja ${o.cashAccountId} abierta en el legacy para ${staff.username} (${hoy} ${hora})`);
  }

  sum.aperturas.abiertasSoloEnLegacy = abiertosAllá
    .filter((u) => !míosHoy.has(u.id))
    .map((u) => ({ id: u.id, usuario: u.username, hora: u.hinicial }));
  if (sum.aperturas.abiertasSoloEnLegacy.length) {
    log(`aperturas: ${sum.aperturas.abiertasSoloEnLegacy.length} abiertas SÓLO en el legacy`
      + ` (${sum.aperturas.abiertasSoloEnLegacy.map((u) => u.usuario).join(', ')}) — aquí no consta apertura`);
  }
}

async function pushTransactions(my, sum) {
  const todas = await prisma.transaction.findMany({
    where: { legacyId: null },
    include: { subscriber: { select: { legacyId: true } }, invoice: { select: { tid: true, legacyId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const rows = CAJA_DESDE ? todas.filter((t) => t.createdAt >= CAJA_DESDE) : todas;
  const fuera = todas.length - rows.length;
  sum.transactions = {
    pendientes: rows.length, insertadas: 0, adoptadas: 0, facturasAlDia: 0, sinFacturaEnLegacy: 0,
    omitidasPorCorte: fuera, duplicadasEnNexus: [],
  };
  if (fuera) log(`transactions: ${fuera} anteriores al corte ${CAJA_DESDE.toISOString().slice(0, 10)} — NO viajan`);
  if (!CAJA_LIVE) {
    if (rows.length) log(`transactions: ${rows.length} ${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de caja cerrado)'}`);
    return;
  }
  for (const t of rows) {
    const facturaAllá = t.invoice?.legacyId != null;
    const tid = facturaAllá ? t.invoice.tid : 0;
    if (t.invoice && !facturaAllá) sum.transactions.sinFacturaEnLegacy++;

    const gemelo = await gemeloEnLegacy(my, t, tid);
    if (gemelo) {
      // Ya estaba allá. Si la ida todavía no la trajo, se ENLAZA (queda la misma fila
      // en los dos lados). Si la ida ya la trajo, este movimiento es una COPIA que
      // sobra en nuestro propio libro: no se puede enlazar (legacyId es único) y
      // empujarla duplicaría la plata allá. Se deja quieta y se reporta —borrar
      // dinero registrado no es cosa de un cron.
      const yaImportada = await prisma.transaction.findUnique({
        where: { legacyId: gemelo }, select: { id: true },
      });
      if (yaImportada) {
        sum.transactions.duplicadasEnNexus.push({ id: t.id, legacyId: gemelo, factura: tid });
        log(`transactions: ${t.id} duplica a #${gemelo} (factura ${tid}) — ni se empuja ni se enlaza`);
        continue;
      }
      await prisma.transaction.update({ where: { id: t.id }, data: { legacyId: gemelo } });
      sum.transactions.adoptadas++;
      log(`transactions: adoptada #${gemelo} del legacy (factura ${tid}) en vez de duplicarla`);
      continue;
    }

    const fila = invTx(t, t.subscriber?.legacyId ?? 0, tid);
    if (t.invoice && !facturaAllá) {
      fila.note = `Factura ${t.invoice.tid} (nexus) · ${fila.note}`.slice(0, 255);
    }
    const id = await insertRow(my, 'transactions', fila);
    await prisma.transaction.update({ where: { id: t.id }, data: { legacyId: id } });
    sum.transactions.insertadas++;
    if (await reflejarEnLegacy(my, t, tid)) sum.transactions.facturasAlDia++;
  }
  if (rows.length) {
    log(`transactions: +${sum.transactions.insertadas} insertadas, ${sum.transactions.adoptadas} adoptadas,`
      + ` ${sum.transactions.duplicadasEnNexus.length} duplicadas aquí (sin tocar),`
      + ` ${sum.transactions.facturasAlDia} facturas puestas al día en el legacy`);
  }
}

/**
 * Enlace del comprobante en la nota del legacy.
 *
 * Va en un paso APARTE de `pushTransactions` porque el comprobante casi siempre se
 * adjunta DESPUÉS de registrar el movimiento —la cajera cobra y luego sube la foto—,
 * cuando la fila de allá ya existe y su nota ya viajó sin enlace.
 */
async function pushComprobantes(my, sum) {
  const rows = await prisma.transaction.findMany({
    where: { attach: { not: null }, legacyId: { not: null } },
    select: { legacyId: true, note: true, attach: true },
  });
  sum.comprobantes = { conAdjunto: rows.length, enlazados: 0 };
  if (!rows.length) return;

  const [actuales] = await my.query('SELECT id, note FROM transactions WHERE id IN (?)', [rows.map((r) => r.legacyId)]);
  const notaPorId = new Map(actuales.map((r) => [r.id, r.note]));
  const faltan = rows.filter((t) => notaPorId.has(t.legacyId) && !tieneComprobante(notaPorId.get(t.legacyId), t.attach));
  sum.comprobantes.pendientes = faltan.length;
  if (!CAJA_LIVE) {
    if (faltan.length) log(`comprobantes: ${faltan.length} ${DRY ? 'en plan (seco)' : 'RETENIDOS (gate de caja cerrado)'}`);
    return;
  }
  for (const t of faltan) {
    await updateRow(my, 'transactions', 'id', t.legacyId, { note: notaConComprobante(t.note, t.attach) });
    sum.comprobantes.enlazados++;
  }
  if (faltan.length) log(`comprobantes: ${faltan.length} enlaces escritos en la nota del legacy`);
}

/**
 * Recibos de caja creados aquí → `recibos_de_pago` del legacy.
 *
 * Sólo viaja el recibo cuyo MOVIMIENTO llegó allá (`pushTransactions` le dejó
 * `legacyId`). Un recibo sin movimiento en el legacy no certifica nada de ese lado, y
 * empujarlo igual deja registros de cobro sueltos: es lo que pasó al abrir el gate el
 * 2026-08-24 —se colaron 8 recibos de pagos que el legacy ya tenía anotados a mano
 * (los duplicados en nexus) y uno de una prueba de pantalla, y hubo que borrarlos.
 */
async function pushReceipts(my, sum) {
  const todos = await prisma.paymentReceipt.findMany({
    where: { legacyId: null },
    include: { invoice: { select: { tid: true } }, transactions: { include: { transaction: { select: { legacyId: true } } } } },
  });
  const rows = todos.filter((rc) => rc.transactions.some((l) => l.transaction?.legacyId));
  let enlaces = 0;
  sum.recibos = { insertados: rows.length, enlaces: 0, sinMovimientoEnLegacy: todos.length - rows.length };
  if (sum.recibos.sinMovimientoEnLegacy) {
    log(`recibos: ${sum.recibos.sinMovimientoEnLegacy} sin movimiento en el legacy → no viajan`);
  }
  if (!CAJA_LIVE) { sum.recibos.enlaces = rows.reduce((a, r) => a + r.transactions.length, 0); return; }
  for (const rc of rows) {
    const id = await insertRow(my, 'recibos_de_pago', {
      date: toDT(rc.date), file_name: rc.fileName ?? '', tid: rc.invoice?.tid ?? 0,
    });
    await prisma.paymentReceipt.update({ where: { id: rc.id }, data: { legacyId: id } });
    for (const link of rc.transactions) {
      const txLegacy = link.transaction?.legacyId;
      if (!txLegacy) continue;
      await insertRow(my, 'transactions_ids_recibos_de_pago', { id_recibo_de_pago: id, id_transaccion: txLegacy });
      enlaces++;
    }
  }
  sum.recibos.enlaces = enlaces;
}

async function pushVoidings(my, sum) {
  const rows = await prisma.voiding.findMany({
    where: { legacyId: null }, include: { transaction: { select: { legacyId: true } } },
  });
  const listos = rows.filter((v) => v.transaction?.legacyId);
  sum.anulaciones = { insertadas: listos.length, sinTransaccion: rows.length - listos.length };
  if (!CAJA_LIVE) return;
  for (const v of listos) {
    const id = await insertRow(my, 'anulaciones', {
      fecha_hora: toDT(v.dateTime), detalle: v.detail ?? '', transactions_id: v.transaction.legacyId,
      razon_anulacion: v.reason ?? '', usuario_anula: v.voidedBy ?? '',
    });
    await prisma.voiding.update({ where: { id: v.id }, data: { legacyId: id } });
    await my.execute('UPDATE transactions SET estado = ? WHERE id = ?', ['Anulada', v.transaction.legacyId]);
  }
}

async function pushEstados(my, sum, st) {
  // PG no guarda legacyId de estados: candidatos = filas nuevas por createdAt, y se
  // filtran las que ya existen en MySQL (esas las trajo la ida, no son nuestras).
  // primera corrida: solo las últimas 24 h (el resto es historial que ya vino de la ida)
  const since = st.wb?.estadosPushedSince ? new Date(st.wb.estadosPushedSince) : new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.subscriberStatusHistory.findMany({
    where: { createdAt: { gt: since } },
    include: { subscriber: { select: { legacyId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  let insertados = 0, maxCreated = since;
  const pushedIds = [...(st.wb?.estadosPushed ?? [])];
  const plan = [];
  for (const h of rows) {
    if (h.createdAt > maxCreated) maxCreated = h.createdAt;
    const cid = h.subscriber?.legacyId;
    if (!cid) continue;
    const fecha = toDT(h.date), estado = inv(SUB_STATUS_INV)(h.status);
    if (!estado) continue;
    if (!dentroDelCorteAltas(h.createdAt)) continue; // anterior al corte de altas
    const [[dupe]] = await my.query('SELECT id FROM estados WHERE cid=? AND fecha=? AND estado=? LIMIT 1', [cid, fecha, estado]);
    if (dupe) continue; // vino del legacy vía la ida
    plan.push({ cid, fecha, estado, col: h.originTicketId ?? 0 });
  }
  sum.estados = { insertados: plan.length };
  if (!ALTAS_LIVE) return;
  for (const p of plan) {
    const id = await insertRow(my, 'estados', p);
    pushedIds.push(id); insertados++;
  }
  await saveState({ estadosPushedSince: maxCreated.toISOString(), estadosPushed: pushedIds });
}

/**
 * Reconexión hecha AQUÍ → legacy.
 *
 * Es el paso que faltaba para que un pago cobrado en este sistema signifique lo mismo
 * en los dos lados. Sin él la plata llegaba (gate de caja) pero el estado no, y la ida
 * del sync devolvía el 'Cortado' del legacy a los pocos minutos: el cliente navegando
 * y las dos pantallas diciendo que está cortado.
 *
 * Se copia el bloque de reconexión del legacy (`Transactions.php`): estado del abonado
 * a Activo —guardando el anterior en `ultimo_estado`— y, en sus facturas, el estado del
 * servicio a NULL con el `ron` en Activo. El historial (`estados`) lo empuja `pushEstados`.
 *
 * No lleva marca de agua a propósito: es IDEMPOTENTE (cuando allá ya dice Activo no hay
 * nada que empujar), así que una pasada perdida se recupera sola en la siguiente.
 */
async function pushReconexiones(my, sum) {
  const desde = new Date(Date.now() - RECONEXION_DIAS * 24 * 3600 * 1000);

  // Qué cuenta como "aquí se reconectó a este abonado". Dos rastros, porque ninguno
  // solo los cubre todos:
  //  · la fila de historial que escribe `marcarActivo` — pero ésa NO existe cuando el
  //    abonado ya figuraba ACTIVO y estaba cortado igual (el corte del legacy no mueve
  //    el estado: son 221 casos), y
  //  · la orden `Reconexion …` que deja `registrarReconexion` por cada servicio que
  //    volvió de verdad — ésa sí se escribe siempre, y además dice QUÉ volvió.
  // Sólo las órdenes NACIDAS AQUÍ: las que bajaron por la ida son reconexiones que hizo
  // el propio legacy y no hay nada que devolverle. El discriminante es
  // `createdBySource` —quién la abrió— y NO `legacyId: null`, que es lo que había y
  // dejaba esta pasada prácticamente ciega: `pushTickets` le sella el `legacyId` a la
  // orden en cuanto la empuja, y eso pasa a los pocos segundos de crearla
  // (`TICKET_CREADO_EVENT` dispara el empuje inmediato). Cuando esta consulta corría, la
  // orden de reconexión YA tenía `legacyId` y no la veía nadie: el corte se quedaba en
  // la factura del legacy y la ida lo devolvía aquí (orden #505799, 09-09-2026; en toda
  // la base sólo quedaban 7 órdenes con `legacyId` nulo).
  const [hist, ordenes] = await Promise.all([
    prisma.subscriberStatusHistory.findMany({
      where: { status: 'ACTIVO', date: { gte: desde }, note: { startsWith: 'Reconexión' } },
      include: { subscriber: { select: { id: true, abonado: true, legacyId: true } } },
    }),
    prisma.ticket.findMany({
      where: {
        createdAt: { gte: desde },
        createdBySource: { in: ['USUARIO', 'SISTEMA', 'CHATBOT'] },
        type: { startsWith: 'Reconexion ' },
      },
      select: {
        subscriberId: true, type: true, createdAt: true,
        subscriber: { select: { id: true, abonado: true, legacyId: true } },
      },
    }),
  ]);

  const porCid = new Map(); // cid del legacy → { fecha, sub, internet, tv }
  const anotar = (sub, fecha) => {
    if (!sub?.legacyId) return null; // alta de aquí que aún no viajó
    const prev = porCid.get(sub.legacyId);
    if (prev) { if (fecha > prev.fecha) prev.fecha = fecha; return prev; }
    const nuevo = { fecha, sub, internet: false, tv: false };
    porCid.set(sub.legacyId, nuevo);
    return nuevo;
  };
  for (const h of hist) anotar(h.subscriber, h.date);
  for (const o of ordenes) {
    const e = anotar(o.subscriber, o.createdAt);
    if (!e) continue;
    if (o.type.startsWith('Reconexion Internet') || o.type.startsWith('Reconexion Combo')) e.internet = true;
    if (o.type.startsWith('Reconexion Television') || o.type.startsWith('Reconexion Combo')) e.tv = true;
    e.ordenes = (e.ordenes ?? []).concat({ type: o.type, fecha: o.createdAt });
  }

  sum.reconexiones = { candidatos: porCid.size, clientes: 0, facturas: 0, aplicados: 0, omitidos: [] };
  if (!porCid.size) return;

  const cids = [...porCid.keys()];
  const [rows] = await my.query(
    `SELECT id, usu_estado, fecha_cambio FROM customers WHERE id IN (${cids.map(() => '?').join(',')})`, cids);

  const omitir = (abonado, motivo) => {
    if (sum.reconexiones.omitidos.length < 50) sum.reconexiones.omitidos.push({ abonado, motivo });
  };
  // `plan` = a quién hay que cambiarle el estado allá. `conFacturas` = de quién se
  // pueden levantar las facturas, que incluye a los que allá ya están en Activo (los
  // 221 que nunca perdieron el estado pero sí el servicio: el estado ya está bien,
  // pero el `estado_combo` de su factura sigue diciendo Cortado y es lo que se pinta).
  const plan = [], conFacturas = [];
  for (const r of rows) {
    const rec = porCid.get(r.id);
    if (!rec) continue;
    const estado = norm(r.usu_estado);
    const corteLegacy = r.fecha_cambio ? new Date(r.fecha_cambio) : null;
    // `corteLegacy` en la entrada es "la fecha del corte que el legacy TODAVÍA enseña",
    // no la de su último cambio de estado: si allá ya no está cortado, no hay tal corte
    // y no tiene que frenar nada más abajo (`vale`).
    const entrada = {
      cid: r.id, abonado: rec.sub.abonado, subId: rec.sub.id, anterior: estado, fecha: rec.fecha,
      corteLegacy: ESTADOS_CORTE_LEGACY.has(estado) ? corteLegacy : null,
      ...rec,
    };
    // El legacy manda si lo suyo es más nuevo: un CORTE posterior a la reconexión no se
    // levanta desde aquí (pagó, y después volvió a caer en mora).
    //
    // Y sólo si lo que hizo después es un corte. `fecha_cambio` no es "cuándo lo
    // cortaron" sino "cuándo le cambiaron el estado por última vez", así que una
    // REACTIVACIÓN posterior del legacy caía en este mismo freno y se descartaba al
    // abonado entero — justo cuando más falta hace, porque la cajera de allá reconecta
    // a medias: pone `usu_estado='Activo'` y deja el `estado_combo` de la factura en
    // 'Cortado', que es lo que pinta la ficha. Es lo que le pasó al abonado 2131 el
    // 09-09-2026 (el legacy lo activó a las 13:52 y su factura siguió cortada).
    if (corteLegacy && corteLegacy > rec.fecha && ESTADOS_CORTE_LEGACY.has(estado)) {
      omitir(rec.sub.abonado, 'el legacy lo volvió a cortar después de la reconexión');
      continue;
    }
    if (estado === 'Activo') { conFacturas.push(entrada); continue; } // allá ya está al día
    // El acuerdo de pago se respeta: su factura sí deja de estar cortada —el servicio
    // volvió de verdad y es lo que el cliente ve— pero el estado se queda en Compromiso.
    if (estado === 'Compromiso') { conFacturas.push(entrada); continue; }
    if (!ESTADOS_CORTE_LEGACY.has(estado)) { omitir(rec.sub.abonado, `en el legacy está ${estado || '—'}`); continue; }
    plan.push(entrada);
    conFacturas.push(entrada);
  }

  // Facturas: sólo el servicio que la reconexión devolvió DE VERDAD — al que perdió
  // sólo el internet no se le levanta la TV de regalo. Basta una de dos señales:
  //  · la factura ya está limpia AQUÍ (`levantarCorteDeFactura` acaba de hacerlo), o
  //  · hay una orden `Reconexion …` de este sistema posterior al corte del legacy.
  // La segunda es la que aguanta: si la ida se coló entre medias y devolvió el
  // 'Cortado' a la factura de aquí, la orden sigue ahí y el empuje no se pierde.
  const facturas = [];
  if (conFacturas.length) {
    const porSub = new Map(conFacturas.map((p) => [p.subId, p]));
    // SÓLO la factura VIGENTE de cada abonado: la que el legacy levanta al cobrar y la
    // única que se pinta en la ficha. Las anteriores marcadas 'Cortado' son el rastro
    // de cortes viejos —hay abonados con 22, desde 2021— y no se reescribe el historial
    // de la mora de nadie (sin este candado el plan pasaba de 35 facturas a 154).
    const pgInv = await prisma.$queryRaw`
      SELECT DISTINCT ON (i."subscriberId")
             i."legacyId", i.tid, i."subscriberId", i."estadoTv"::text AS "estadoTv",
             i."estadoCombo"::text AS "estadoCombo", i.ron::text AS ron
        FROM "SubInvoice" i
       WHERE i."subscriberId" = ANY(${[...porSub.keys()]})
         AND i.kind = 'RECURRENTE' AND i."legacyId" IS NOT NULL
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    const aqui = new Map(pgInv.map((i) => [Number(i.legacyId), i]));
    const idsF = [...aqui.keys()];
    if (!idsF.length) return;
    const [invRows] = await my.query(
      `SELECT id, tid, estado_tv, estado_combo, ron FROM invoices
        WHERE id IN (${idsF.map(() => '?').join(',')})
          AND (estado_tv = 'Cortado' OR estado_combo = 'Cortado')`, idsF);
    for (const r of invRows) {
      const pg = aqui.get(r.id);
      if (!pg) continue;
      const p = porSub.get(pg.subscriberId);
      if (!p) continue;
      // La orden tiene que ser posterior al corte que el legacy todavía enseña.
      const vale = (o) => !p.corteLegacy || o.fecha >= p.corteLegacy;
      const devolvio = (svc) => (p.ordenes ?? []).some((o) => vale(o)
        && (o.type.startsWith(svc) || o.type.startsWith('Reconexion Combo')));
      const set = {};
      if (norm(r.estado_combo) === 'Cortado' && (pg.estadoCombo === null || devolvio('Reconexion Internet'))) set.estado_combo = null;
      if (norm(r.estado_tv) === 'Cortado' && (pg.estadoTv === null || devolvio('Reconexion Television'))) set.estado_tv = null;
      if (!Object.keys(set).length) continue;
      // El `ron` es del abonado, no de un servicio: sólo se levanta si en esa factura
      // no queda ningún corte en pie.
      const quedaCorte = (norm(r.estado_combo) === 'Cortado' && !('estado_combo' in set))
        || (norm(r.estado_tv) === 'Cortado' && !('estado_tv' in set));
      if (norm(r.ron) === 'Cortado' && !quedaCorte) set.ron = 'Activo';
      facturas.push({ id: r.id, tid: r.tid, abonado: p.abonado, set });
    }
  }

  sum.reconexiones.clientes = plan.length;
  sum.reconexiones.facturas = facturas.length;
  // Muestra de lo que se va a escribir en las facturas: en seco es la única forma de
  // revisar el plan antes de abrir el gate, y en vivo deja constancia de la forma.
  sum.reconexiones.muestra = facturas.slice(0, 5).map((f) => ({ abonado: f.abonado, tid: f.tid, ...f.set }));
  if (!plan.length && !facturas.length) return;
  if (!RECONEXION_LIVE) {
    log(`reconexión: ${plan.length} clientes y ${facturas.length} facturas `
      + `${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de reconexión cerrado)'}`
      + ` → abonados ${plan.slice(0, 15).map((p) => p.abonado).join(',')}${plan.length > 15 ? '…' : ''}`);
    return;
  }
  for (const p of plan) {
    await updateRow(my, 'customers', 'id', p.cid, {
      usu_estado: 'Activo', ultimo_estado: p.anterior, fecha_cambio: toDT(p.fecha),
    });
  }
  for (const f of facturas) await updateRow(my, 'invoices', 'id', f.id, f.set);
  sum.reconexiones.aplicados = plan.length;
  log(`reconexión: ${plan.length} clientes y ${facturas.length} facturas puestos en Activo en el legacy`);
}

/**
 * ACTIVACIÓN del que quedó instalado → legacy. Ver el gate `ACTIVACION_LIVE`.
 *
 * TRES rastros, porque ninguno solo los cubre todos:
 *  · la orden de instalación CERRADA AQUÍ (`editedAt`) — el rastro que nunca falta,
 *    porque sobrevive a que la ida ya haya devuelto el 'INSTALAR' a la ficha (que es
 *    justo lo que pasa: cuando esta pasada corre, el estado de aquí puede estar ya
 *    deshecho y sólo queda la orden para saber que se instaló);
 *  · la fila de historial en ACTIVO — que recoge lo que no viene de una orden: el
 *    cambio de estado a mano desde la ficha, que se deshacía igual; y
 *  · los TRABAJOS QUE DEJAN INSTALADO cerrados EN EL LEGACY (`TRABAJOS_QUE_INSTALAN`).
 *    Éste es de otra clase y merece explicación: el legacy pone al abonado en
 *    'Instalar' al abrir un 'AgregarInternet' o una 'Migracion' —para que salga la
 *    visita— pero su bloque de activación (`Tickets.php`) sólo contempla 'Instalacion',
 *    'Activacion' y las 'Reconexion …2', así que al cerrarlas NO lo devuelve. Nadie lo
 *    devuelve: se queda en 'Instalar' para siempre. Y en 'Instalar' NO SE FACTURA —la
 *    corrida sólo mira facturables—, así que es un cliente conectado, con la ONU
 *    autenticada y al día, al que se dejó de cobrar. El abonado 3504 llevaba así desde
 *    el 10-08-2026 (se le saltó septiembre) y el 3653 desde el 19-08-2025: un año.
 *    Por eso este rastro se lee de la tabla `tickets` del LEGACY y no de la de aquí:
 *    esas órdenes las cierra allá el técnico, así que en nexus no traen `resolvedAt`
 *    —es un sello nuestro— y su `finalDate` puede venir sin refrescar.
 */
async function pushActivaciones(my, sum) {
  const desde = new Date(Date.now() - ACTIVACION_DIAS * 24 * 3600 * 1000);
  const [ordenes, hist, delLegacy] = await Promise.all([
    prisma.ticket.findMany({
      where: {
        status: 'RESUELTO',
        resolvedAt: { gte: desde },
        editedAt: { not: null }, // cerrada aquí: la 'Instalacion' que cerró el legacy ya se activó allá
        // Los cinco trabajos que dejan al cliente conectado, no sólo la instalación:
        // cerrar aquí un 'AgregarInternet', una 'Migracion', un 'Traslado' o un
        // 'Cambio de equipo' también deja instalado a quien venía en 'Instalar'
        // (`esTrabajoDeConexion` en el backend). Quién se activa de verdad lo decide
        // el candado de abajo: el que allá siga en 'Instalar', nadie más.
        OR: [
          { type: { contains: 'nstalac', mode: 'insensitive' } }, // Instalacion · Reinstalación
          { type: { contains: 'traslado', mode: 'insensitive' } },
          { type: { contains: 'migraci', mode: 'insensitive' } },
          { type: { contains: 'cambio de equipo', mode: 'insensitive' } },
          { type: { contains: 'agregarinternet', mode: 'insensitive' } },
        ],
      },
      select: {
        code: true, resolvedAt: true,
        subscriber: { select: { id: true, abonado: true, legacyId: true } },
      },
    }),
    prisma.subscriberStatusHistory.findMany({
      where: { status: 'ACTIVO', date: { gte: desde } },
      include: { subscriber: { select: { id: true, abonado: true, legacyId: true } } },
    }),
    // El tercer rastro, contra el legacy y ya acotado a los que allá siguen 'Instalar':
    // es una lista corta (decenas), no hace falta traerse la tabla.
    my.query(
      `SELECT t.cid, t.codigo, MAX(COALESCE(NULLIF(t.fecha_final,'0000-00-00'), t.created)) AS fecha
         FROM tickets t JOIN customers c ON c.id = t.cid
        WHERE c.usu_estado = ? AND t.status = 'Resuelto'
          AND t.detalle IN (${TRABAJOS_QUE_INSTALAN.map(() => '?').join(',')})
          AND COALESCE(NULLIF(t.fecha_final,'0000-00-00'), t.created) >= ?
        GROUP BY t.cid`,
      [ESTADO_POR_INSTALAR_LEGACY, ...TRABAJOS_QUE_INSTALAN, desde],
    ),
  ]);

  const porCid = new Map(); // cid del legacy → la activación MÁS RECIENTE de ese abonado
  const anotar = (sub, fecha, code) => {
    if (!sub?.legacyId || !fecha) return;
    const prev = porCid.get(sub.legacyId);
    if (!prev || fecha >= prev.fecha) porCid.set(sub.legacyId, { fecha, sub, code: code ?? prev?.code ?? null });
  };
  for (const o of ordenes) anotar(o.subscriber, o.resolvedAt, o.code);
  for (const h of hist) anotar(h.subscriber, h.date, h.originTicketId);
  // Los del legacy vienen con `cid`: hay que traducirlo a la ficha de aquí para poder
  // nombrar al abonado en el plan y en el log.
  const filasLegacy = delLegacy?.[0] ?? [];
  if (filasLegacy.length) {
    const subs = await prisma.subscriber.findMany({
      where: { legacyId: { in: filasLegacy.map((f) => f.cid) } },
      select: { id: true, abonado: true, legacyId: true },
    });
    const porLegacyId = new Map(subs.map((x) => [x.legacyId, x]));
    for (const f of filasLegacy) anotar(porLegacyId.get(f.cid), new Date(f.fecha), f.codigo);
  }

  sum.activaciones = { candidatos: porCid.size, clientes: 0, aplicados: 0, omitidos: [] };
  if (!porCid.size) return;
  const omitir = (abonado, motivo) => {
    if (sum.activaciones.omitidos.length < 50) sum.activaciones.omitidos.push({ abonado, motivo });
  };

  const cids = [...porCid.keys()];
  const [rows] = await my.query(
    `SELECT id, usu_estado, fecha_cambio FROM customers WHERE id IN (${cids.map(() => '?').join(',')})`, cids);

  const plan = [];
  for (const r of rows) {
    const a = porCid.get(r.id);
    if (!a) continue;
    const estadoLegacy = norm(r.usu_estado);
    // El candado: sólo el que allá sigue "por instalar". Todo lo demás es un estado que
    // el legacy mueve por su cuenta y que no se pisa desde aquí.
    if (estadoLegacy !== ESTADO_POR_INSTALAR_LEGACY) {
      if (estadoLegacy !== 'Activo') omitir(a.sub.abonado, `en el legacy está ${estadoLegacy || '—'}`);
      continue;
    }
    const cambioLegacy = r.fecha_cambio ? new Date(r.fecha_cambio) : null;
    if (cambioLegacy && cambioLegacy > a.fecha) { omitir(a.sub.abonado, 'el legacy cambió el estado después de la instalación'); continue; }
    plan.push({ cid: r.id, abonado: a.sub.abonado, anterior: r.usu_estado ?? '', fecha: a.fecha, code: a.code });
  }

  sum.activaciones.clientes = plan.length;
  sum.activaciones.muestra = plan.slice(0, 5).map((p) => ({ abonado: p.abonado, orden: p.code }));
  if (!plan.length) return;
  if (!ACTIVACION_LIVE) {
    log(`activación: ${plan.length} clientes `
      + `${DRY ? 'en plan (seco)' : 'RETENIDOS (gate de activación cerrado)'}`
      + ` → abonados ${plan.slice(0, 15).map((p) => p.abonado).join(',')}${plan.length > 15 ? '…' : ''}`);
    return;
  }
  for (const p of plan) {
    await updateRow(my, 'customers', 'id', p.cid, {
      usu_estado: 'Activo', ultimo_estado: p.anterior, fecha_cambio: toDT(p.fecha),
    });
  }
  sum.activaciones.aplicados = plan.length;
  log(`activación: ${plan.length} clientes instalados puestos en Activo en el legacy`);
}

// ---------- main ----------
// ---------- borrados (aquí → legacy) ----------
/**
 * BORRADOS hechos aquí, llevados al legacy.
 *
 * Se apoya en las lápidas (`LegacyDeletion`, ver `anotarBorradoLegacy` en el backend):
 * cuando se borra en Nexus una fila que vino del legacy, queda anotado su `legacyId`,
 * que es el único rastro que sobrevive al borrado.
 *
 * Cada entidad tiene su freno, y el freno gana siempre: una fila con plata o con
 * historial colgando NO se borra allá aunque aquí ya no esté. Se anota el motivo en la
 * lápida y se deja para que lo mire una persona. Preferir el huérfano al agujero es la
 * misma regla que sigue `syncBorradas` en la ida, que anula en vez de borrar.
 */
const FRENOS = {
  // Factura: si allá tiene pagos o recibos, borrarla deja el dinero sin a qué apuntar.
  subInvoice: async (my, id) => {
    const [[f]] = await my.query('SELECT id, tid, pamnt FROM invoices WHERE id = ?', [id]);
    if (!f) return { ausente: true };
    if (num(f.pamnt) > 0) return { motivo: `tiene ${f.pamnt} pagados en el legacy` };
    const [[{ n }]] = await my.query('SELECT COUNT(*) AS n FROM transactions WHERE tid = ?', [f.tid]);
    if (n) return { motivo: `tiene ${n} movimiento(s) de caja en el legacy` };
    return { tid: f.tid };
  },
  supplyOrder: async (my, id) => {
    const [[o]] = await my.query('SELECT id, tid, pamnt FROM purchase WHERE id = ?', [id]);
    if (!o) return { ausente: true };
    if (num(o.pamnt) > 0) return { motivo: `tiene ${o.pamnt} abonados en el legacy` };
    return { tid: o.tid };
  },
  // Material: si aparece en alguna compra, borrarlo deja renglones sin producto.
  material: async (my, id) => {
    const [[p]] = await my.query('SELECT pid FROM products WHERE pid = ?', [id]);
    if (!p) return { ausente: true };
    const [[{ n }]] = await my.query('SELECT COUNT(*) AS n FROM purchase_items WHERE pid = ?', [id]);
    if (n) return { motivo: `aparece en ${n} renglón(es) de compra en el legacy` };
    return {};
  },
  // Equipo: si allá figura instalado en casa de alguien, no se toca.
  equipment: async (my, id) => {
    const [[e]] = await my.query('SELECT id, asignado FROM equipos WHERE id = ?', [id]);
    if (!e) return { ausente: true };
    if (norm(e.asignado)) return { motivo: `figura asignado al abonado ${e.asignado} en el legacy` };
    return {};
  },
  supplier: async (my, id) => {
    const [[p]] = await my.query('SELECT id FROM supplier WHERE id = ?', [id]);
    if (!p) return { ausente: true };
    const [[{ n }]] = await my.query('SELECT COUNT(*) AS n FROM purchase WHERE csd = ?', [id]);
    if (n) return { motivo: `tiene ${n} orden(es) de compra en el legacy` };
    return {};
  },
};

/** Qué hay que borrar allá por cada entidad, una vez pasado el freno. */
const BORRAR = {
  subInvoice: async (my, id, ctx) => {
    await my.execute('DELETE FROM invoice_items WHERE tid = ?', [ctx.tid]);
    await my.execute('DELETE FROM invoices WHERE id = ?', [id]);
  },
  supplyOrder: async (my, id, ctx) => {
    await my.execute('DELETE FROM purchase_items WHERE tid = ?', [ctx.tid]);
    await my.execute('DELETE FROM purchase WHERE id = ?', [id]);
  },
  material: async (my, id) => { await my.execute('DELETE FROM products WHERE pid = ?', [id]); },
  equipment: async (my, id) => { await my.execute('DELETE FROM equipos WHERE id = ?', [id]); },
  supplier: async (my, id) => { await my.execute('DELETE FROM supplier WHERE id = ?', [id]); },
};

async function pushBorrados(my, sum) {
  const pendientes = await prisma.legacyDeletion.findMany({
    where: { pushedAt: null }, orderBy: { deletedAt: 'asc' },
  });
  const res = { pendientes: pendientes.length, borrados: 0, yaNoEstaban: 0, frenados: [] };
  sum.borrados = res;
  if (!pendientes.length) return;

  for (const l of pendientes) {
    const freno = FRENOS[l.entity];
    if (!freno) {
      res.frenados.push({ entidad: l.entity, id: l.legacyId, motivo: 'entidad sin regla de borrado' });
      continue;
    }
    const ctx = await freno(my, l.legacyId);
    if (ctx.ausente) {
      // Ya no está allá (lo borró el legacy, o esta misma pasada en un intento previo):
      // la lápida ha cumplido y se cierra.
      res.yaNoEstaban++;
      if (BORRADOS_LIVE) {
        await prisma.legacyDeletion.update({
          where: { id: l.id }, data: { pushedAt: new Date(), note: 'ya no existía en el legacy' },
        });
      }
      continue;
    }
    if (ctx.motivo) {
      res.frenados.push({ entidad: l.entity, id: l.legacyId, etiqueta: l.label, motivo: ctx.motivo });
      // El motivo se guarda aunque el gate esté cerrado: es lo que hay que leer para
      // decidir, y sin escribirlo habría que volver a correr el writeback para verlo.
      if (l.note !== ctx.motivo) {
        await prisma.legacyDeletion.update({ where: { id: l.id }, data: { note: ctx.motivo } });
      }
      continue;
    }
    res.borrados++;
    if (!BORRADOS_LIVE) continue;
    await BORRAR[l.entity](my, l.legacyId, ctx);
    await prisma.legacyDeletion.update({ where: { id: l.id }, data: { pushedAt: new Date(), note: null } });
  }

  if (res.borrados) {
    log(`borrados: ${res.borrados} ${BORRADOS_LIVE ? 'propagados al legacy' : `${DRY ? 'en plan (seco)' : 'RETENIDOS (gate de borrados cerrado)'}`}`);
  }
  for (const f of res.frenados) {
    log(`borrados: ${f.entidad}#${f.id}${f.etiqueta ? ` (${f.etiqueta})` : ''} NO se borra allá — ${f.motivo}`);
  }
}

// ---------- inventario (aquí → legacy) ----------
/**
 * INVENTARIO hacia el legacy: material, equipos y órdenes de compra.
 *
 * Tres bloques con la misma forma, la misma que ya usan clientes y facturas:
 *   · ALTAS   → filas nacidas aquí (`legacyId` null). Se insertan allá y se guarda el id
 *               que asigna MySQL, que es lo que las enlaza y lo que evita que la ida las
 *               vuelva a crear como si fueran nuevas.
 *   · CAMBIOS → filas del legacy que este sistema tocó (`editedAt`). La ida ya se aparta
 *               de ellas por completo, así que empujarlas no puede entrar en bucle.
 *
 * De las dimensiones (categorías, bodegas, proveedores) sólo viaja UNA: el almacén de
 * material de un técnico, y por lo que se explica en `pushAlmacenesDeTecnico`. El resto
 * no se toca: una fila de material que apunta a una bodega creada aquí no puede existir
 * allá —el legacy no conoce esa bodega— y se reporta en vez de inventarle un destino.
 */
/**
 * El almacén de material de un técnico, la única dimensión que sube.
 *
 * `product_warehouse.id_tecnico` es como el legacy ata el material a una persona, y de
 * él dependen las dos puntas: aquí, la lista de "traspasar a técnico" (que se arma con
 * las bodegas, no con los empleados); y allá, `Tickets.php`, que busca el almacén por
 * `id_tecnico` para descontar lo que el técnico gastó al cerrar la orden. Allá el
 * almacén lo crea alguien a mano y con los técnicos nuevos nadie lo hizo, así que lo
 * crea la ida (`sync-legacy-vivo.js`, paso de empleados) y lo empuja este bloque.
 *
 * Va aquí y no en el otro script porque las escrituras al legacy viven en éste, y
 * porque el `legacyId` que devuelve MySQL es lo que impide el duplicado: sin él, el día
 * que alguien cree el almacén allá la ida lo bajaría como una bodega NUEVA y el técnico
 * acabaría con dos.
 *
 * Sólo las de un técnico que EXISTA en el legacy (`Staff.legacyId`). Las de perfiles
 * que sólo viven aquí —la bodega de prueba, un empleado dado de alta en nexus— no
 * tienen a quién colgarse allá y se quedan.
 */
async function pushAlmacenesDeTecnico(my, res) {
  const nuevas = await prisma.materialWarehouse.findMany({
    where: { legacyId: null, technicianRef: { not: null } },
    select: { id: true, title: true, extra: true, technicianRef: true },
  });
  if (!nuevas.length) return;
  const fichas = await prisma.staff.findMany({
    where: { legacyId: { not: null }, username: { not: null } },
    select: { username: true },
  });
  const enElLegacy = new Set(fichas.map((f) => f.username.trim().toLowerCase()));
  for (const w of nuevas) {
    if (!enElLegacy.has(w.technicianRef.trim().toLowerCase())) { res.bodegasTecnico.sinTecnico.push(w.title); continue; }
    res.bodegasTecnico.nuevas++;
    if (!INVENTARIO_LIVE) continue;
    const id = await insertRow(my, 'product_warehouse', { title: w.title, extra: w.extra, id_tecnico: w.technicianRef });
    await prisma.materialWarehouse.update({ where: { id: w.id }, data: { legacyId: id } });
    res.bodegasTecnico.insertadas++;
    log(`inventario: almacén "${w.title}" creado en el legacy (product_warehouse ${id}, técnico ${w.technicianRef})`);
  }
}

async function pushInventario(my, sum) {
  const hoy = toD(new Date());
  const res = {
    bodegasTecnico: { nuevas: 0, insertadas: 0, sinTecnico: [] },
    material: { nuevos: 0, insertados: 0, cambios: 0, aplicados: 0, sinDimension: [], fueraDeCorte: 0 },
    equipos: { nuevos: 0, insertados: 0, cambios: 0, aplicados: 0, sinBodega: [], fueraDeCorte: 0 },
    ordenes: { nuevas: 0, insertadas: 0, cambios: 0, aplicados: 0, conflictosTid: [], items: 0, fueraDeCorte: 0 },
  };
  sum.inventario = res;

  // --- 0) Almacenes de técnico (`product_warehouse`) ---------------------------
  // Primero: el material que se le entregue cuelga de esta bodega, así que allá tiene
  // que existir antes.
  await pushAlmacenesDeTecnico(my, res);

  // --- 1) Material (`products`) ------------------------------------------------
  const matNuevos = await prisma.material.findMany({ where: { legacyId: null } });
  const matDentro = matNuevos.filter((m) => dentroDelCorteInventario(m.createdAt));
  res.material.fueraDeCorte = matNuevos.length - matDentro.length;
  for (const m of matDentro) {
    // Sin la categoría y la bodega del legacy no hay dónde colgarlo allá.
    if (m.categoryLegacy == null || m.warehouseLegacy == null) {
      res.material.sinDimension.push(m.name);
      continue;
    }
    res.material.nuevos++;
    if (!INVENTARIO_LIVE) continue;
    const pid = await insertRow(my, 'products', invMaterial(m));
    await prisma.material.update({ where: { id: m.id }, data: { legacyId: pid } });
    res.material.insertados++;
  }

  const matEditados = await prisma.material.findMany({ where: { editedAt: { not: null }, legacyId: { not: null } } });
  if (matEditados.length) {
    const [filas] = await my.query('SELECT * FROM products WHERE pid IN (?)', [matEditados.map((m) => m.legacyId)]);
    const allá = new Map(filas.map((r) => [r.pid, r]));
    for (const m of matEditados) {
      const r = allá.get(m.legacyId);
      if (!r) continue; // borrado allá: no se resucita desde aquí
      const nuestro = invMaterial(m);
      const distintos = Object.keys(nuestro).filter((c) => !sameVal(nuestro[c], r[c]));
      // Ya coincide con el legacy (se empujó en una pasada anterior): el sello sobra y
      // dejarlo puesto congelaría la fila. Se suelta y vuelve a mandar la ida.
      if (!distintos.length) {
        if (INVENTARIO_LIVE) await prisma.material.update({ where: { id: m.id }, data: { editedAt: null } });
        continue;
      }
      res.material.cambios++;
      if (!INVENTARIO_LIVE) continue;
      const setObj = {};
      for (const c of distintos) setObj[c] = nuestro[c];
      await updateRow(my, 'products', 'pid', m.legacyId, setObj);
      // Cambio entregado: se suelta el blindaje. `editedAt` significa "tengo algo que
      // llevar allá", no "esta fila es mía para siempre" — dejarlo puesto congelaría la
      // ficha y el legacy no volvería a poder moverla nunca (y allá se sigue moviendo).
      await prisma.material.update({ where: { id: m.id }, data: { editedAt: null } });
      res.material.aplicados++;
    }
  }

  // --- 2) Equipos (`equipos`) --------------------------------------------------
  const eqTodos = await prisma.equipment.findMany({ where: { legacyId: null } });
  const eqNuevos = eqTodos.filter((e) => dentroDelCorteInventario(e.createdAt));
  res.equipos.fueraDeCorte = eqTodos.length - eqNuevos.length;
  for (const e of eqNuevos) {
    if (e.warehouseLegacy == null) { res.equipos.sinBodega.push(e.code ?? e.serial ?? e.id); continue; }
    res.equipos.nuevos++;
    if (!INVENTARIO_LIVE) continue;
    const id = await insertRow(my, 'equipos', invEquipo(e, hoy));
    await prisma.equipment.update({ where: { id: e.id }, data: { legacyId: id } });
    res.equipos.insertados++;
  }

  const eqEditados = await prisma.equipment.findMany({ where: { editedAt: { not: null }, legacyId: { not: null } } });
  if (eqEditados.length) {
    const [filas] = await my.query('SELECT * FROM equipos WHERE id IN (?)', [eqEditados.map((e) => e.legacyId)]);
    const allá = new Map(filas.map((r) => [r.id, r]));
    for (const e of eqEditados) {
      const r = allá.get(e.legacyId);
      if (!r) continue;
      const nuestro = invEquipo(e, hoy);
      // `llegada`/`final` se rellenaron con la fecha de hoy si venían vacías: compararlas
      // marcaría un cambio falso en cada pasada y reescribiría la fila para siempre.
      const distintos = Object.keys(nuestro)
        .filter((c) => !(c === 'llegada' && !e.arrival) && !(c === 'final' && !e.endDate))
        .filter((c) => !sameVal(nuestro[c], r[c]));
      if (!distintos.length) {
        if (INVENTARIO_LIVE) await prisma.equipment.update({ where: { id: e.id }, data: { editedAt: null } });
        continue;
      }
      res.equipos.cambios++;
      if (!INVENTARIO_LIVE) continue;
      const setObj = {};
      for (const c of distintos) setObj[c] = nuestro[c];
      await updateRow(my, 'equipos', 'id', e.legacyId, setObj);
      await prisma.equipment.update({ where: { id: e.id }, data: { editedAt: null } });
      res.equipos.aplicados++;
    }
  }

  // --- 3) Órdenes de compra (`purchase` + `purchase_items`) --------------------
  const poNuevas = await prisma.supplyOrder.findMany({
    where: { legacyId: null },
    include: { items: true, supplier: { select: { legacyId: true } } },
  });
  const poDentro = poNuevas.filter((o) => dentroDelCorteInventario(o.createdAt));
  res.ordenes.fueraDeCorte = poNuevas.length - poDentro.length;
  for (const o of poDentro) {
    // El `tid` de las órdenes NO está particionado (a diferencia de facturas y órdenes
    // de servicio): los dos sistemas reparten sobre la misma numeración, así que hay que
    // mirar antes de insertar o el índice único de allá tumba la fila.
    const [[dupe]] = await my.query('SELECT id FROM purchase WHERE tid = ? LIMIT 1', [o.tid]);
    if (dupe) { res.ordenes.conflictosTid.push(o.tid); continue; }
    res.ordenes.nuevas++;
    if (!INVENTARIO_LIVE) continue;
    const id = await insertRow(my, 'purchase', invOrden(o, o.supplier?.legacyId ?? o.supplierLegacy, hoy));
    await prisma.supplyOrder.update({ where: { id: o.id }, data: { legacyId: id } });
    res.ordenes.insertadas++;
    for (const it of o.items) {
      const itemId = await insertRow(my, 'purchase_items', invOrdenItem(it, o.tid));
      await prisma.supplyOrderItem.update({ where: { id: it.id }, data: { legacyId: itemId } });
      res.ordenes.items++;
    }
  }

  const poEditadas = await prisma.supplyOrder.findMany({
    where: { editedAt: { not: null }, legacyId: { not: null } },
    include: { supplier: { select: { legacyId: true } } },
  });
  if (poEditadas.length) {
    const [filas] = await my.query('SELECT * FROM purchase WHERE id IN (?)', [poEditadas.map((o) => o.legacyId)]);
    const allá = new Map(filas.map((r) => [r.id, r]));
    for (const o of poEditadas) {
      const r = allá.get(o.legacyId);
      if (!r) continue;
      const nuestro = invOrden(o, o.supplier?.legacyId ?? o.supplierLegacy, hoy);
      // El consecutivo y los campos del flujo del legacy (eid/aid/a2id/discstatus/term)
      // no se reescriben: aquí no significan nada y allá sí.
      const fijos = new Set(['tid', 'eid', 'aid', 'a2id', 'discstatus', 'term']);
      const distintos = Object.keys(nuestro).filter((c) => !fijos.has(c) && !sameVal(nuestro[c], r[c]));
      if (!distintos.length) {
        if (INVENTARIO_LIVE) await prisma.supplyOrder.update({ where: { id: o.id }, data: { editedAt: null } });
        continue;
      }
      res.ordenes.cambios++;
      if (!INVENTARIO_LIVE) continue;
      const setObj = {};
      for (const c of distintos) setObj[c] = nuestro[c];
      await updateRow(my, 'purchase', 'id', o.legacyId, setObj);
      await prisma.supplyOrder.update({ where: { id: o.id }, data: { editedAt: null } });
      res.ordenes.aplicados++;
    }
  }

  const pendientes = res.material.nuevos + res.material.cambios + res.equipos.nuevos
    + res.equipos.cambios + res.ordenes.nuevas + res.ordenes.cambios;
  if (pendientes) {
    log(`inventario: material +${res.material.nuevos}/~${res.material.cambios}`
      + ` · equipos +${res.equipos.nuevos}/~${res.equipos.cambios}`
      + ` · órdenes +${res.ordenes.nuevas}/~${res.ordenes.cambios}`
      + (INVENTARIO_LIVE ? '' : ` ${DRY ? 'en plan (seco)' : 'RETENIDO (gate de inventario cerrado)'}`));
  }
  if (res.material.sinDimension.length) {
    log(`inventario: ${res.material.sinDimension.length} materiales con bodega o categoría que no existe en el legacy`
      + ` (${res.material.sinDimension.slice(0, 5).join(', ')}) — no pueden subir`);
  }
  if (res.ordenes.conflictosTid.length) {
    log(`inventario: ⚠️ ${res.ordenes.conflictosTid.length} órdenes con consecutivo ya usado allá: ${res.ordenes.conflictosTid.join(',')}`);
  }
}

/**
 * Nº de orden libre en el legacy, tomado de SU contador y bajo su mismo candado.
 *
 * El legacy numera con `MAX(codigo)+1` (`Tickets.php`, `Invoices_model.php` y cuatro
 * sitios más), así que el rango partido de nexus —desde 500.000, para no pisarle nada—
 * duró exactamente hasta el primer empuje: al recibir la orden 500.006 el legacy tomó
 * ese máximo como suyo y siguió contando desde ahí. Hoy va por 504.170 mientras la
 * secuencia de aquí va por 500.130, y cada orden nueva de nexus nace con un número que
 * allá YA es de otro trabajo. Partir el rango otra vez no arregla nada: el legacy vuelve
 * a adoptar el máximo que le llegue, sea cual sea.
 *
 * Mientras los técnicos trabajen en el legacy, el número lo reparte el legacy. `GET_LOCK`
 * es el candado que él no se pone —dos usuarios suyos concurrentes SÍ pueden sacar el
 * mismo número, es un fallo suyo de siempre— y que aquí sí conviene, porque el writeback
 * inserta en ráfaga: sin él, las órdenes de una misma pasada se pisarían entre ellas.
 */
async function nextLegacyTicketCode(my) {
  const [[{ n }]] = await my.query("SELECT GET_LOCK('nexus_ticket_codigo', 10) AS n");
  if (!n) throw new Error('no se pudo tomar el candado del consecutivo de órdenes en el legacy');
  try {
    const [[row]] = await my.query('SELECT COALESCE(MAX(codigo), 0) + 1 AS siguiente FROM tickets');
    return Number(row.siguiente);
  } finally {
    await my.query("SELECT RELEASE_LOCK('nexus_ticket_codigo')");
  }
}

/**
 * BAJA hecha AQUÍ (retiro o suspensión) → legacy.
 *
 * Gemela de `pushReconexiones` y por el mismo motivo, del revés: el estado del abonado
 * es de los `CAMPOS_DE_ALLA` de la ida, así que una baja que el legacy no conozca dura
 * lo que tarde la siguiente pasada del sync —quince minutos— y después el cliente
 * retirado vuelve a aparecer ACTIVO en las dos pantallas. Es exactamente lo que pasó al
 * cerrar la orden #504994 el 31-08-2026: el técnico retiró, la cascada dejó RETIRADO y
 * a las 17:15 la ida lo devolvió a Activo.
 *
 * Se copia el bloque de 'Retiro voluntario' del legacy (`Tickets.php`): estado del
 * abonado —guardando el anterior en `ultimo_estado`— y, en su factura vigente,
 * `estado_tv`/`estado_combo` a 'Suspendido' con el `ron` en el estado nuevo. El
 * historial (`estados`) lo empuja `pushEstados`, igual que en la reconexión.
 *
 * Candados, porque esto escribe sobre filas que en Modo A manda el legacy:
 *  · sólo si la baja de AQUÍ es más nueva que el `fecha_cambio` de allá (si el legacy
 *    lo movió después, manda el legacy);
 *  · nunca se REBAJA una baja ya puesta: a un Retirado o un Depurado del legacy no se
 *    le escribe Suspendido encima.
 * No lleva marca de agua: es idempotente (cuando allá ya dice Retirado no hay nada que
 * empujar), así que una pasada perdida se recupera sola.
 */
async function pushBajas(my, sum) {
  const desde = new Date(Date.now() - BAJAS_DIAS * 24 * 3600 * 1000);
  // El rastro es la fila de historial que escribe quien da la baja: la cascada de
  // cierre de orden (`applyCloseCascade`), el cambio manual de la ficha y la
  // devolución de equipo. Las que bajaron de la ida también entran y no molestan:
  // si vinieron del legacy, allá ya está ese estado y no hay nada que escribir.
  const hist = await prisma.subscriberStatusHistory.findMany({
    where: { status: { in: ['RETIRADO', 'SUSPENDIDO'] }, date: { gte: desde } },
    include: { subscriber: { select: { id: true, abonado: true, legacyId: true } } },
    orderBy: { date: 'asc' },
  });

  // Y la FICHA misma, que es el rastro que nunca falta: hasta el 31-08-2026 la cascada
  // de cierre cambiaba el estado sin escribir historial, así que hay bajas que sólo
  // existen aquí (la orden #504994, sin ir más lejos). Las que vinieron de la ida
  // entran también y no molestan: si el estado lo puso el legacy, allá ya está y no
  // queda nada que escribir.
  const fichas = await prisma.subscriber.findMany({
    where: { status: { in: ['RETIRADO', 'SUSPENDIDO'] }, statusChangedAt: { gte: desde }, legacyId: { not: null } },
    select: { id: true, abonado: true, legacyId: true, status: true, statusChangedAt: true },
  });

  const porCid = new Map(); // cid del legacy → la baja MÁS RECIENTE de ese abonado
  const anotar = (cid, fecha, estado, sub) => {
    if (!cid || !fecha) return;
    const prev = porCid.get(cid);
    if (!prev || fecha >= prev.fecha) porCid.set(cid, { fecha, estado, sub });
  };
  for (const h of hist) anotar(h.subscriber?.legacyId, h.date, h.status, h.subscriber);
  for (const f of fichas) anotar(f.legacyId, f.statusChangedAt, f.status, f);

  sum.bajas = { candidatos: porCid.size, clientes: 0, facturas: 0, aplicados: 0, omitidos: [] };
  if (!porCid.size) return;
  const omitir = (abonado, motivo) => {
    if (sum.bajas.omitidos.length < 50) sum.bajas.omitidos.push({ abonado, motivo });
  };

  const cids = [...porCid.keys()];
  const [rows] = await my.query(
    `SELECT id, usu_estado, fecha_cambio FROM customers WHERE id IN (${cids.map(() => '?').join(',')})`, cids);

  // `plan` = a quién hay que cambiarle el estado allá. `conFacturas` = de quién se puede
  // marcar la factura, que incluye a los que allá YA están de baja: su estado está bien,
  // pero su factura puede seguir diciendo que el servicio está al aire (es lo que pinta
  // la ficha, y en las bajas hechas aquí antes del 31-08-2026 nunca se tocó).
  const plan = [], conFacturas = [];
  for (const r of rows) {
    const b = porCid.get(r.id);
    if (!b) continue;
    const objetivo = inv(SUB_STATUS_INV)(b.estado); // 'Retirado' | 'Suspendido'
    if (!objetivo) continue;
    const estadoLegacy = norm(r.usu_estado);
    const entrada = { cid: r.id, abonado: b.sub.abonado, subId: b.sub.id, anterior: r.usu_estado ?? '', objetivo, fecha: b.fecha };
    if (estadoLegacy === objetivo) { conFacturas.push(entrada); continue; } // allá ya está
    const cambioLegacy = r.fecha_cambio ? new Date(r.fecha_cambio) : null;
    if (cambioLegacy && cambioLegacy > b.fecha) { omitir(b.sub.abonado, 'el legacy cambió el estado después de la baja'); continue; }
    if (ESTADOS_BAJA_LEGACY.has(estadoLegacy) && objetivo !== 'Retirado') { omitir(b.sub.abonado, `en el legacy ya está ${estadoLegacy}`); continue; }
    if (BAJAS_IRREVERSIBLES_LEGACY.has(estadoLegacy)) { omitir(b.sub.abonado, `en el legacy ya está ${estadoLegacy}`); continue; }
    plan.push(entrada);
    conFacturas.push(entrada);
  }

  // La factura VIGENTE, que es donde la ficha —aquí y allá— lee qué servicio cayó. Se
  // copia lo que este sistema ya escribió en ella (`marcarBajaEnFactura`); las
  // anteriores no se tocan, son el rastro de bajas viejas.
  const facturas = [];
  if (conFacturas.length) {
    const porSub = new Map(conFacturas.map((p) => [p.subId, p]));
    const pgInv = await prisma.$queryRaw`
      SELECT DISTINCT ON (i."subscriberId")
             i."legacyId", i.tid, i."subscriberId", i."estadoTv"::text AS "estadoTv",
             i."estadoCombo"::text AS "estadoCombo", i.ron::text AS ron
        FROM "SubInvoice" i
       WHERE i."subscriberId" = ANY(${[...porSub.keys()]})
         AND i.kind = 'RECURRENTE' AND i."legacyId" IS NOT NULL
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    const aqui = new Map(pgInv.map((i) => [Number(i.legacyId), i]));
    const idsF = [...aqui.keys()];
    if (idsF.length) {
      const [invRows] = await my.query(
        `SELECT id, tid, estado_tv, estado_combo, ron FROM invoices WHERE id IN (${idsF.map(() => '?').join(',')})`, idsF);
      for (const r of invRows) {
        const pg = aqui.get(r.id);
        const p = pg && porSub.get(pg.subscriberId);
        if (!p) continue;
        const set = {};
        // Sólo el servicio que AQUÍ quedó de baja: al que suspendió la televisión no se
        // le tumba el internet en la factura del legacy.
        if (pg.estadoCombo === 'SUSPENDIDO' && norm(r.estado_combo) !== 'Suspendido') set.estado_combo = 'Suspendido';
        if (pg.estadoTv === 'SUSPENDIDO' && norm(r.estado_tv) !== 'Suspendido') set.estado_tv = 'Suspendido';
        const ron = inv(RON_INV)(pg.ron);
        if (ron && (ron === 'Retirado' || ron === 'Suspendido') && norm(r.ron) !== ron) set.ron = ron;
        if (Object.keys(set).length) facturas.push({ id: r.id, tid: r.tid, abonado: p.abonado, set });
      }
    }
  }

  sum.bajas.clientes = plan.length;
  sum.bajas.facturas = facturas.length;
  sum.bajas.muestra = plan.slice(0, 5).map((p) => ({ abonado: p.abonado, de: p.anterior, a: p.objetivo }));
  if (!plan.length && !facturas.length) return;
  if (!BAJAS_LIVE) {
    log(`bajas: ${plan.length} clientes y ${facturas.length} facturas `
      + `${DRY ? 'en plan (seco)' : 'RETENIDAS (gate de bajas cerrado)'}`
      + ` → abonados ${plan.slice(0, 15).map((p) => p.abonado).join(',')}${plan.length > 15 ? '…' : ''}`);
    return;
  }
  for (const p of plan) {
    await updateRow(my, 'customers', 'id', p.cid, {
      usu_estado: p.objetivo, ultimo_estado: p.anterior, fecha_cambio: toDT(p.fecha),
    });
  }
  for (const f of facturas) await updateRow(my, 'invoices', 'id', f.id, f.set);
  sum.bajas.aplicados = plan.length;
  log(`bajas: ${plan.length} clientes y ${facturas.length} facturas dados de baja en el legacy`);
}

/**
 * Renumera una orden de ESTE lado al código que le tocó en el legacy.
 *
 * `Ticket.code` no es una clave técnica: es el número por el que preguntan el cliente y
 * el técnico, y cuelgan de él los seguimientos (`TicketThread.ticketCode`). Si se
 * renumera, se renumeran juntos o el historial se queda huérfano.
 *
 * Los seguimientos se mueven acotados al ABONADO y sólo los nacidos aquí (`legacyId`
 * nulo). El atasco dejó 130 códigos repetidos DENTRO de nexus —el mismo número en una
 * orden de aquí y en otra que bajó del legacy—, así que un `updateMany` por código a
 * secas se llevaría por delante el historial de la orden ajena.
 */
async function renumerarTicket(t, nuevo) {
  if (t.code === nuevo) return;
  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({ where: { id: t.id }, data: { code: nuevo } });
    if (t.code != null) {
      await tx.ticketThread.updateMany({
        where: { ticketCode: t.code, legacyId: null, subscriberId: t.subscriberId },
        data: { ticketCode: nuevo },
      });
    }
  });
}

async function pushTickets(my, sum) {
  const rows = await prisma.ticket.findMany({
    where: { legacyId: null },
    include: {
      subscriber: { select: { legacyId: true } },
      // El legacy busca al técnico por `username`, no por nombre. Ver `invTicket`.
      assignedStaff: { select: { username: true } },
    },
    orderBy: { code: 'asc' },
  });
  const sinCliente = [], renumeradas = [];
  const inserts = [];
  for (const t of rows) {
    const cid = t.subscriber?.legacyId;
    // `tickets.cid` es NOT NULL allá: una orden sin abonado (las que abre el chatbot
    // para un interesado que todavía no es cliente) no tiene dónde colgarse en el
    // legacy. Se reporta y se queda aquí.
    if (!cid) { sinCliente.push(t.code); continue; }
    inserts.push({ t, cid });
  }
  const lote = inserts.slice(0, LIMITE);
  sum.tickets = {
    insertadas: 0, pendientes: inserts.length, enEstaPasada: lote.length,
    sinCliente: sinCliente.length, renumeradas: [],
  };
  if (sinCliente.length) log(`tickets: ${sinCliente.length} sin abonado (cid es NOT NULL allá) → se quedan aquí`);
  if (!TICKETS_LIVE) {
    if (inserts.length) log(`tickets: ${inserts.length} órdenes en plan (seco)`);
    return;
  }
  for (const { t, cid } of lote) {
    // El código se pide DENTRO del bucle, no antes: entre orden y orden el legacy
    // puede haber repartido el suyo, y un lote calculado de golpe nacería pisado.
    const [[dupe]] = await my.query('SELECT idt FROM tickets WHERE codigo = ? LIMIT 1', [t.code]);
    const codigo = dupe ? await nextLegacyTicketCode(my) : t.code;
    const id = await insertRow(my, 'tickets', invTicket({ ...t, code: codigo }, cid));
    if (codigo !== t.code) {
      renumeradas.push({ antes: t.code, ahora: codigo });
      await renumerarTicket(t, codigo);
    }
    await prisma.ticket.update({ where: { id: t.id }, data: { legacyId: id } });
    sum.tickets.insertadas++;
  }
  sum.tickets.renumeradas = renumeradas;
  if (sum.tickets.insertadas) log(`tickets: +${sum.tickets.insertadas} órdenes empujadas al legacy`);
  if (renumeradas.length) {
    log(`tickets: ${renumeradas.length} renumeradas porque su código ya era de otra orden allá`
      + ` (${renumeradas.slice(0, 5).map((r) => `${r.antes}→${r.ahora}`).join(', ')})`);
  }
  // La secuencia de aquí se deja POR ENCIMA del máximo real de allá. No evita el choque
  // —el legacy sigue repartiendo por su cuenta y para eso está la renumeración—, pero sí
  // que sea el caso normal: sin esto, nexus reparte 4.000 números por detrás del legacy y
  // se renumeraría absolutamente todo, que es como llegamos aquí.
  await sincronizarSecuenciaCodigo(my, sum);
}

/** Adelanta `Ticket_code_seq` al máximo real de los dos lados. */
async function sincronizarSecuenciaCodigo(my, sum) {
  const [[{ mx }]] = await my.query('SELECT COALESCE(MAX(codigo), 0) AS mx FROM tickets');
  const [{ max_code: mine }] = await prisma.$queryRawUnsafe('SELECT COALESCE(MAX(code), 0)::int AS max_code FROM "Ticket"');
  const objetivo = Math.max(Number(mx), Number(mine)) + 1;
  const [{ last_value: actual }] = await prisma.$queryRawUnsafe('SELECT last_value FROM "Ticket_code_seq"');
  if (Number(actual) >= objetivo) return;
  await prisma.$queryRawUnsafe(`SELECT setval('"Ticket_code_seq"', ${objetivo}, false)`);
  sum.tickets.secuencia = { antes: Number(actual), ahora: objetivo };
  log(`tickets: consecutivo local adelantado ${actual} → ${objetivo} (máximo real del legacy)`);
}

/**
 * Cambios hechos AQUÍ sobre órdenes que ya viven en el legacy (cierre, técnico, firma).
 *
 * Es la otra mitad de la bidireccionalidad: sin esto la orden nace en los dos lados
 * pero sólo vive en uno. Entran las marcadas con `editedAt` — las que este sistema
 * tocó en algo que el legacy también guarda — y la ida ya las está dejando en paz.
 *
 * No lleva marca de agua: compara contra la fila real del legacy y empuja sólo las
 * columnas que difieren. Así es idempotente y además se auto-corrige si una pasada
 * anterior quedó a medias.
 */
/**
 * La dirección nueva de un traslado, hacia el legacy.
 *
 * Allá `tickets` no tiene columna para el destino: lo guarda en `temporales`, una
 * fila por orden atada por `corden` = **código** de la orden. Sin esta pasada, un
 * traslado abierto aquí llegaba al legacy como un "Traslado" a secas y el técnico
 * que trabaja en el sistema viejo no veía a qué casa ir — justo al revés del
 * agujero que tenía la ida.
 *
 * Es idempotente y no pisa nada: si la orden ya tiene su fila allá (las 3.748 que
 * bajaron de allí, para empezar), se deja como está. El destino no se corrige desde
 * aquí; lo que hace falta es que EXISTA.
 */
async function pushDestinoTraslados(my, sum) {
  // Solo las que ya viven allá: sin `legacyId` la orden todavía no existe en el
  // legacy y su código puede cambiar al empujarla (ver `renumerarTicket`).
  const pendientes = await prisma.ticket.findMany({
    where: { legacyId: { not: null }, code: { not: null }, moveToText: { not: null } },
    select: { id: true, code: true, moveTo: true, moveInvoiceTid: true },
    orderBy: { code: 'asc' },
  });
  const codigos = pendientes.map((t) => t.code);
  const yaEstan = new Set();
  for (let i = 0; i < codigos.length; i += 2000) {
    const trozo = codigos.slice(i, i + 2000);
    const [filas] = await my.query(
      `SELECT corden FROM temporales WHERE corden IN (${trozo.map(() => '?').join(',')})`, trozo);
    for (const f of filas) yaEstan.add(Number(f.corden));
  }
  const faltan = pendientes.filter((t) => !yaEstan.has(t.code));
  sum.trasladosDestino = { conDestino: pendientes.length, faltabanAlla: faltan.length, escritas: 0 };
  if (!faltan.length) return;
  if (!TICKETS_LIVE) {
    log(`traslados: ${faltan.length} direcciones de traslado en plan (seco)`);
    return;
  }
  for (const t of faltan.slice(0, LIMITE)) {
    const n = (t.moveTo && t.moveTo.nomenclature) || {};
    const txt = (v) => norm(v);
    // Las casillas de `temporales` se llaman distinto que las de la ficha, y varias
    // son NOT NULL sin valor por defecto: van vacías, nunca nulas.
    await insertRow(my, 'temporales', {
      corden: t.code,
      nomenclatura: txt(n.nomenclatura), nuno: txt(n.numero1), auno: txt(n.adicionauno),
      ndos: txt(n.numero2), ados: txt(n.adicional2), ntres: Number(n.numero3) || 0,
      localidad: txt(t.moveTo?.localityRef), barrio: txt(t.moveTo?.neighborhood),
      residencia: txt(n.residencia), referencia: txt(n.referencia),
      // La cesta del cambio de PLAN, que en un traslado no se usa.
      tv: '', internet: '', puntos: '',
      tid_traslado: t.moveInvoiceTid ?? null,
    });
    sum.trasladosDestino.escritas++;
  }
  if (sum.trasladosDestino.escritas) {
    log(`traslados: ${sum.trasladosDestino.escritas} direcciones escritas en el legacy`);
  }
}

async function pushTicketUpdates(my, sum) {
  const rows = await prisma.ticket.findMany({
    where: { legacyId: { not: null }, editedAt: { not: null } },
    include: {
      subscriber: { select: { legacyId: true } },
      assignedStaff: { select: { username: true } },
    },
  });
  const cambios = [];
  for (const t of rows) {
    const [[legacyRow]] = await my.query('SELECT * FROM tickets WHERE idt = ? LIMIT 1', [t.legacyId]);
    if (!legacyRow) continue; // borrada allá: no se resucita desde aquí
    const mapped = invTicket(t, t.subscriber?.legacyId ?? legacyRow.cid);
    const data = {};
    for (const [k, v] of Object.entries(mapped)) {
      // `cid` y `codigo` no se reescriben: mover una orden de abonado o renumerarla
      // desde aquí no es un cambio de estado, es romperle la identidad allá.
      if (k === 'cid' || k === 'codigo') continue;
      if (!sameVal(v, legacyRow[k])) data[k] = v;
    }
    if (Object.keys(data).length) cambios.push({ t, data });
  }
  sum.ticketsUpd = { pendientes: cambios.length, aplicados: 0 };
  if (!TICKETS_LIVE) {
    if (cambios.length) log(`tickets-upd: ${cambios.length} cambios en plan (seco)`);
    return;
  }
  for (const c of cambios) {
    await updateRow(my, 'tickets', 'idt', c.t.legacyId, c.data);
  }
  sum.ticketsUpd.aplicados = cambios.length;
  if (cambios.length) log(`tickets-upd: ${cambios.length} órdenes actualizadas en el legacy`);
}

/** Cuántos días atrás se revisa que el técnico de una orden siga siendo legible allá. */
const ASIGNADO_DIAS = Number(process.env.LEGACY_WRITEBACK_ASIGNADO_DIAS || 90);

/**
 * Realinea el técnico de las órdenes que YA viven en el legacy.
 *
 * Es la reparación del fallo que describe `invTicket`: mientras el mapeo empujó
 * `Ticket.assigned` —el nombre de pila— la orden llegaba al legacy pero no aparecía en
 * la bandeja de nadie, porque allá el filtro del técnico es `asignado = username` con
 * igualdad exacta. Un técnico con trabajo asignado veía su lista vacía.
 *
 * Va aparte de `pushTicketUpdates` a propósito: no puede depender de `editedAt`, porque
 * marcar `editedAt` en estas órdenes las CONGELARÍA frente a la ida (ver el blindaje en
 * `sync-legacy-vivo.js`) y el legacy es justamente quien las cierra. Sólo mira las que
 * tienen un username distinto del texto guardado aquí y, de esas, únicamente contrasta
 * contra MySQL las de los últimos `ASIGNADO_DIAS` días: las viejas se arreglaron una vez
 * y no vuelven a moverse.
 */
async function pushTicketAsignados(my, sum) {
  const desde = new Date(Date.now() - ASIGNADO_DIAS * 24 * 3600 * 1000);
  const rows = await prisma.ticket.findMany({
    where: { legacyId: { not: null }, assignedStaffId: { not: null }, created: { gte: desde } },
    select: { id: true, code: true, legacyId: true, assigned: true, assignedStaff: { select: { username: true } } },
  });
  const candidatas = rows.filter((t) => t.assignedStaff?.username && t.assigned !== t.assignedStaff.username);
  // Un técnico sin usuario en el legacy es un agujero silencioso: su orden llega allá, se
  // ve en los listados de oficina y no le sale a NADIE, porque el legacy sólo sabe buscar
  // por `username`. No se puede arreglar desde aquí —hay que darle usuario allá—, así que
  // por lo menos se nombra en cada pasada en vez de descubrirse cuando el cliente reclama.
  const sinUsuario = [...new Set(rows.filter((t) => !t.assignedStaff?.username).map((t) => t.assigned))].filter(Boolean);
  sum.ticketsAsignado = { revisadas: candidatas.length, desalineadas: 0, aplicados: 0, sinUsuarioEnLegacy: sinUsuario };
  if (sinUsuario.length) {
    log(`tickets-asignado: ⚠️ ${sinUsuario.length} técnico(s) sin usuario en el legacy —sus órdenes no le salen a nadie allá—: ${sinUsuario.join(', ')}`);
  }
  if (!candidatas.length) return;
  const [allá] = await my.query(
    `SELECT idt, asignado FROM tickets WHERE idt IN (${candidatas.map(() => '?').join(',')})`,
    candidatas.map((t) => t.legacyId),
  );
  const porIdt = new Map(allá.map((r) => [Number(r.idt), r.asignado]));
  const arreglar = candidatas.filter((t) => {
    const actual = porIdt.get(t.legacyId);
    return actual !== undefined && actual !== t.assignedStaff.username;
  });
  sum.ticketsAsignado.desalineadas = arreglar.length;
  if (!arreglar.length) return;
  if (!TICKETS_LIVE) {
    log(`tickets-asignado: ${arreglar.length} órdenes con técnico ilegible para el legacy (plan)`);
    return;
  }
  for (const t of arreglar) {
    await updateRow(my, 'tickets', 'idt', t.legacyId, { asignado: t.assignedStaff.username });
  }
  sum.ticketsAsignado.aplicados = arreglar.length;
  log(`tickets-asignado: ${arreglar.length} órdenes ahora sí le salen a su técnico en el legacy`
    + ` (${[...new Set(arreglar.map((t) => t.assignedStaff.username))].slice(0, 6).join(', ')})`);
}

/**
 * Refleja en `promos` (legacy) lo que este sistema decidió para el PORTAL DE PAGOS.
 *
 * Reconcilia: para cada estado de cliente deja exactamente una fila vigente, la
 * inserta, la corrige o la borra según haga falta. Es idempotente — correrlo dos
 * veces seguidas no cambia nada la segunda vez — porque la fila se identifica por el
 * estado al que apunta y no por cuándo se creó.
 *
 * Sólo son publicables las promociones de PORCENTAJE cuyo público sea uno o varios
 * estados (o todos): el portal no sabe de planes, sedes, barrios ni clientes sueltos,
 * y su descuento es siempre `total * porcentaje / 100`. Lo que no encaja se reporta en
 * `omitidas` en vez de publicarse a medias.
 */
async function pushPromosPortal(my, sum) {
  // "Hoy" lo dice el MySQL del legacy, no este proceso: el servidor corre en horario
  // europeo y el PHP del portal compara contra su propio `date("Y-m-d")`. Preguntarle
  // a la misma base es lo único que garantiza que aquí y allá esté vigente LA MISMA fila.
  const [[{ hoy }]] = await my.query('SELECT CAST(CURDATE() AS CHAR) AS hoy');
  const [estadosRows] = await my.query('SELECT id_estado, nombre FROM estados_clientes');
  const idPorNombre = new Map(
    estadosRows.map((e) => [String(e.nombre).trim().toLowerCase(), Number(e.id_estado)]),
  );
  const nombrePorId = new Map(estadosRows.map((e) => [Number(e.id_estado), String(e.nombre).trim()]));
  const idDeEstado = (s) => {
    const nombre = SUB_STATUS_INV[s];
    return nombre ? (idPorNombre.get(nombre.toLowerCase()) ?? null) : null;
  };
  const masDias = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  const promos = await prisma.promotion.findMany({
    where: { portalPublish: true },
    include: {
      subscribers: { select: { id: true } },
      plans: { select: { id: true } },
      branches: { select: { id: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  /** Por qué una promoción marcada para el portal no se puede publicar allá. */
  const motivoNoPublicable = (p) => {
    if (!p.active) return 'está inactiva';
    if (p.discountFormat !== '%')
      return 'el portal sólo sabe descontar un % sobre el total (formato ' + p.discountFormat + ')';
    if (!p.percentage) return 'no tiene porcentaje';
    if (p.subscribers.length || p.plans.length || p.branches.length || p.neighborhoodRefs.length)
      return 'el portal sólo distingue por estado del cliente (no por cliente, plan, sede ni barrio)';
    if (!p.allSubscribers && !p.subscriberStatuses.length) return 'no tiene estados en el público';
    if (toD(p.endDate) < hoy) return 'ya venció';
    return null;
  };

  const omitidas = [];
  const conflictos = [];
  /** id_estado_clientes → fila que debe quedar vigente hoy. */
  const deseado = new Map();
  /** promotionId → idprom[] de las filas que le pertenecen. */
  const idsPorPromo = new Map(promos.map((p) => [p.id, []]));

  for (const p of promos) {
    const motivo = motivoNoPublicable(p);
    if (motivo) { omitidas.push({ promocion: p.name, motivo }); continue; }
    const ini = toD(p.startDate);
    const fin = toD(p.endDate);
    if (ini > hoy) { omitidas.push({ promocion: p.name, motivo: `todavía no empieza (${ini})` }); continue; }

    const estados = p.allSubscribers ? Object.keys(SUB_STATUS_INV) : p.subscriberStatuses;
    for (const s of estados) {
      const idEstado = idDeEstado(s);
      if (idEstado == null) { conflictos.push(`el estado ${s} no existe en estados_clientes del legacy`); continue; }
      const previa = deseado.get(idEstado);
      // Dos promociones vigentes sobre el mismo estado: el portal sólo puede aplicar
      // una. Gana la de mayor porcentaje (el cliente no puede salir perdiendo por un
      // solapamiento que no es cosa suya) y se deja dicho, que es un error de quien
      // arma las campañas y hay que verlo.
      if (previa) {
        const pierde = previa.promo.percentage >= p.percentage ? p : previa.promo;
        const gana = previa.promo.percentage >= p.percentage ? previa.promo : p;
        conflictos.push(
          `«${previa.promo.name}» y «${p.name}» se solapan en ${nombrePorId.get(idEstado)}:`
          + ` se publica «${gana.name}» (${gana.percentage}%) y NO «${pierde.name}» (${pierde.percentage}%)`,
        );
        if (previa.promo.percentage >= p.percentage) continue;
      }
      deseado.set(idEstado, {
        promo: p,
        fila: {
          pro_nombre: `${PROMOS_PREFIJO} ${p.name}`.slice(0, 200),
          f_inicio: ini, f_final: fin, porcentaje: p.percentage,
          id_estado_clientes: idEstado, colaborador: null,
        },
      });
    }
  }

  // Candado: todo estado sin promoción vigente queda con una fila al 0%, que es lo que
  // impide que el PHP caiga en su `else` y regale el porcentaje quemado.
  if (PROMOS_CANDADO) {
    for (const [id, nombre] of nombrePorId) {
      if (deseado.has(id)) continue;
      deseado.set(id, {
        promo: null,
        fila: {
          pro_nombre: `${PROMOS_PREFIJO} sin descuento · ${nombre}`.slice(0, 200),
          f_inicio: hoy, f_final: masDias(hoy, PROMOS_CANDADO_DIAS), porcentaje: 0,
          id_estado_clientes: id, colaborador: null,
        },
      });
    }
  }

  // Lo que hay hoy en el legacy puesto por nosotros, agrupado por estado.
  const [existentes] = await my.execute(
    'SELECT idprom, pro_nombre, f_inicio, f_final, porcentaje, id_estado_clientes'
    + ' FROM promos WHERE pro_nombre LIKE ? ORDER BY idprom',
    [`${PROMOS_PREFIJO}%`],
  );
  const porEstado = new Map();
  for (const r of existentes) {
    const k = Number(r.id_estado_clientes);
    if (!porEstado.has(k)) porEstado.set(k, []);
    porEstado.get(k).push(r);
  }

  const plan = { insert: [], update: [], delete: [] };
  for (const [idEstado, { promo, fila }] of deseado) {
    const filas = porEstado.get(idEstado) ?? [];
    const [primera, ...sobran] = filas;
    // Duplicados nuestros sobre el mismo estado: el azar del `[0]` en el PHP. Fuera.
    for (const s of sobran) plan.delete.push({ row: s, motivo: 'duplicada sobre el mismo estado' });
    if (!primera) { plan.insert.push({ fila, promo, idEstado }); continue; }
    const cambios = {};
    for (const c of ['pro_nombre', 'f_inicio', 'f_final', 'porcentaje']) {
      const actual = c === 'porcentaje' ? Number(primera[c]) : String(primera[c] ?? '');
      const nuevo = c === 'porcentaje' ? Number(fila[c]) : String(fila[c]);
      if (actual !== nuevo) cambios[c] = fila[c];
    }
    if (Object.keys(cambios).length) plan.update.push({ id: primera.idprom, cambios, promo, idEstado });
    if (promo) idsPorPromo.get(promo.id)?.push(Number(primera.idprom));
  }
  // Filas nuestras de estados que ya no llevan nada (promo apagada y candado desactivado).
  for (const [idEstado, filas] of porEstado) {
    if (deseado.has(idEstado)) continue;
    for (const r of filas) plan.delete.push({ row: r, motivo: 'ya no le corresponde promoción a ese estado' });
  }

  // Filas AJENAS vigentes hoy sobre un estado real: le pelean el `[0]` a la nuestra y
  // no se tocan (las puso alguien en el legacy). Sólo se avisa.
  const [ajenas] = await my.execute(
    'SELECT idprom, pro_nombre, porcentaje, id_estado_clientes FROM promos'
    + ' WHERE f_inicio<=? AND f_final>=? AND id_estado_clientes<>0 AND pro_nombre NOT LIKE ?',
    [hoy, hoy, `${PROMOS_PREFIJO}%`],
  );
  for (const a of ajenas) {
    conflictos.push(
      `fila ajena vigente en el legacy: #${a.idprom} «${a.pro_nombre}» ${a.porcentaje}% sobre`
      + ` ${nombrePorId.get(Number(a.id_estado_clientes)) ?? a.id_estado_clientes} — el portal podría aplicarla en vez de la nuestra`,
    );
  }

  // El detalle fila a fila sólo cuando se escribe de verdad o cuando alguien vino a
  // mirar el plan (`--solo=promos`): la pasada completa corre cada 15 minutos y con el
  // gate cerrado dejaría trece líneas idénticas cada vez.
  const detalle = (...a) => { if (PROMOS_LIVE || SOLO_PROMOS) log(...a); };
  for (const { fila, promo } of plan.insert) {
    detalle(`promos: ${PROMOS_LIVE ? '+' : 'plan +'} ${fila.pro_nombre} · ${fila.porcentaje}% · ${nombrePorId.get(fila.id_estado_clientes)} · ${fila.f_inicio}→${fila.f_final}`);
    if (!PROMOS_LIVE) continue;
    const id = await insertRow(my, 'promos', fila);
    if (promo) idsPorPromo.get(promo.id)?.push(Number(id));
  }
  for (const { id, cambios } of plan.update) {
    detalle(`promos: ${PROMOS_LIVE ? '~' : 'plan ~'} #${id} ${JSON.stringify(cambios)}`);
    if (PROMOS_LIVE) await updateRow(my, 'promos', 'idprom', id, cambios);
  }
  for (const { row, motivo } of plan.delete) {
    detalle(`promos: ${PROMOS_LIVE ? '−' : 'plan −'} #${row.idprom} «${row.pro_nombre}» (${motivo})`);
    if (PROMOS_LIVE) await my.execute('DELETE FROM promos WHERE idprom=?', [row.idprom]);
  }

  // Traza en PG: con qué filas quedó publicada cada promoción y cuándo. Sólo cuando de
  // verdad se escribió: en seco, decir "publicada" sería mentira. Y nunca desde la BD
  // de ensayo, cuyos `idprom` no significan nada en producción.
  if (PROMOS_LIVE && TARGET !== 'copy') {
    for (const p of promos) {
      const ids = (idsPorPromo.get(p.id) ?? []).sort((a, b) => a - b);
      const iguales = ids.length === p.legacyPromoIds.length
        && ids.every((x, i) => x === p.legacyPromoIds[i]);
      if (iguales && (ids.length === 0 || p.portalPublishedAt)) continue;
      await prisma.promotion.update({
        where: { id: p.id },
        data: { legacyPromoIds: ids, portalPublishedAt: ids.length ? new Date() : null },
      });
    }
  }

  sum.promosPortal = {
    enVivo: PROMOS_LIVE, candado: PROMOS_CANDADO, hoy,
    publicadas: [...new Set([...deseado.values()].filter((d) => d.promo).map((d) => d.promo.name))],
    estadosConDescuento: [...deseado.entries()].filter(([, d]) => d.fila.porcentaje > 0)
      .map(([id, d]) => `${nombrePorId.get(id)}: ${d.fila.porcentaje}%`),
    estadosCandados: [...deseado.entries()].filter(([, d]) => d.fila.porcentaje === 0)
      .map(([id]) => nombrePorId.get(id)),
    insertadas: plan.insert.length, actualizadas: plan.update.length, borradas: plan.delete.length,
    omitidas, conflictos,
  };
  const s = sum.promosPortal;
  log(`promos: ${PROMOS_LIVE ? 'EN VIVO' : 'plan'} · +${s.insertadas} ~${s.actualizadas} −${s.borradas}`
    + ` · con descuento: ${s.estadosConDescuento.join(', ') || 'ninguno'}`
    + ` · al 0%: ${s.estadosCandados.length}`
    + (s.omitidas.length ? ` · omitidas ${s.omitidas.length}` : '')
    + (s.conflictos.length ? ` · CONFLICTOS ${s.conflictos.length}` : ''));
}

async function main() {
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD en el entorno');
  const t0 = Date.now();
  const my = await mysql.createConnection(MYSQL);
  const st = await loadState();
  const sum = {
    ok: true, mode: 'writeback', dry: DRY, target: `${MYSQL.host}/${MYSQL.database}`,
    modoLegacyActivo: MODE_A, updatesEnVivo: UPDATES_LIVE, ordenesEnVivo: TICKETS_LIVE, cajaEnVivo: CAJA_LIVE,
    altasEnVivo: ALTAS_LIVE, reconexionEnVivo: RECONEXION_LIVE, bajasEnVivo: BAJAS_LIVE,
    activacionEnVivo: ACTIVACION_LIVE,
    inventarioEnVivo: INVENTARIO_LIVE, edicionesEnVivo: EDITS_LIVE, servicioEnVivo: SERVICIO_LIVE,
    borradosEnVivo: BORRADOS_LIVE,
    soloCaja: SOLO_CAJA, soloAperturas: SOLO_APERTURAS, soloReconexion: SOLO_RECONEXION,
    promosPortalEnVivo: PROMOS_LIVE,
    soloBorrados: SOLO_BORRADOS, soloOrdenes: SOLO_ORDENES, soloBajas: SOLO_BAJAS, soloPromos: SOLO_PROMOS,
    soloEstadoServicio: SOLO_ESTADO_SERVICIO, soloActivacion: SOLO_ACTIVACION,
  };
  log(`writeback${SOLO_PROMOS ? ' (sólo promociones del portal)' : SOLO_APERTURAS ? ' (sólo aperturas)' : SOLO_BAJAS ? ' (sólo bajas)' : SOLO_ESTADO_SERVICIO ? ' (sólo estado de servicio)' : SOLO_ACTIVACION ? ' (sólo activación)' : SOLO_RECONEXION ? ' (sólo reconexión)' : SOLO_ORDENES ? ' (sólo órdenes)' : SOLO_CAJA ? ' (sólo caja)' : ''} → ${sum.target} · ${DRY ? 'SECO (plan)' : 'EN VIVO'}`
    + ` · órdenes ${TICKETS_LIVE ? 'EN VIVO' : 'en plan'} · caja ${CAJA_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · altas ${ALTAS_LIVE ? 'EN VIVO' : 'en plan'} · reconexión ${RECONEXION_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · bajas ${BAJAS_LIVE ? 'EN VIVO' : 'en plan'} · activación ${ACTIVACION_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · inventario ${INVENTARIO_LIVE ? 'EN VIVO' : 'en plan'} · ediciones ${EDITS_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · servicio ${SERVICIO_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · borrados ${BORRADOS_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · promos del portal ${PROMOS_LIVE ? 'EN VIVO' : 'en plan'}`
    + ` · updates ${UPDATES_LIVE ? 'en vivo' : 'retenidos'}`);

  // La pasada CORTA (`--solo=caja`) se salta todo lo que relee tablas enteras. El orden
  // de los cuatro pasos de caja importa: el recibo y la anulación necesitan que su
  // movimiento ya tenga `legacyId`, y el comprobante que el movimiento exista allá.
  if (SOLO_PROMOS) {
    await pushPromosPortal(my, sum);
  } else if (SOLO_BORRADOS) {
    await pushBorrados(my, sum);
  } else if (SOLO_APERTURAS) {
    await pushCashOpens(my, sum);
  } else if (SOLO_RECONEXION) {
    await pushReconexiones(my, sum);
    // Va con ella porque comparten columnas: al levantar el corte de un servicio hay
    // marcas que soltar, y el que reconecta no tiene por qué saberlo.
    await pushEstadoServicio(my, sum);
  } else if (SOLO_BAJAS) {
    await pushBajas(my, sum);
    // Ídem: el cierre de una orden de sólo televisión no mueve el estado del abonado
    // —así que `pushBajas` no lo ve— pero sí baja el servicio en su factura.
    await pushEstadoServicio(my, sum);
  } else if (SOLO_ESTADO_SERVICIO) {
    await pushEstadoServicio(my, sum);
  } else if (SOLO_ACTIVACION) {
    // El historial va con ella: la fila de `estados` es la otra mitad de lo que el
    // legacy escribe al cerrar una instalación, y sin ella allá queda el estado sin
    // constancia de cuándo cambió.
    await pushEstados(my, sum, st);
    await pushActivaciones(my, sum);
  } else if (SOLO_ORDENES) {
    await pushTickets(my, sum);
    await pushTicketUpdates(my, sum);
    await pushTicketAsignados(my, sum);
    await pushDestinoTraslados(my, sum);
  } else if (SOLO_CAJA) {
    await pushCashOpens(my, sum);
    await pushTransactions(my, sum);
    await pushReceipts(my, sum);
    await pushVoidings(my, sum);
    await pushComprobantes(my, sum);
  } else {
    await pushCustomers(my, sum);
    await pushCustomerUpdates(my, sum);
    await pushCustomerEdits(my, sum);
    await pushInvoices(my, sum);
    await pushItems(my, sum);
    await pushEditedInvoices(my, st, sum);
    await pushServicioAsignado(my, sum);
    await pushInvoiceUpdates(my, sum);
    await pushCashOpens(my, sum);
    await pushTransactions(my, sum);
    await pushReceipts(my, sum);
    await pushVoidings(my, sum);
    await pushComprobantes(my, sum);
    await pushEstados(my, sum, st);
    await pushReconexiones(my, sum);
    await pushActivaciones(my, sum);
    await pushBajas(my, sum);
    await pushEstadoServicio(my, sum);
    await pushTickets(my, sum);
    await pushTicketUpdates(my, sum);
    await pushTicketAsignados(my, sum);
    await pushDestinoTraslados(my, sum);
    await pushInventario(my, sum);
    await pushBorrados(my, sum);
    await pushPromosPortal(my, sum);
  }

  if (!DRY || CAJA_LIVE || TICKETS_LIVE || ALTAS_LIVE || RECONEXION_LIVE || BAJAS_LIVE || ACTIVACION_LIVE) await saveState({ lastWritebackAt: new Date().toISOString() });
  sum.ms = Date.now() - t0;
  console.log(JSON.stringify(sum));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  console.error(e);
  process.exit(1);
});
