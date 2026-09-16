/**
 * Suscripciones al bus de eventos (sustituyen al decorador `@OnEvent`).
 *
 * Con Nest esto era invisible: nueve métodos repartidos por siete ficheros que Nest
 * descubría por reflexión al arrancar. Para saber quién reaccionaba a "pago aplicado"
 * había que buscar `@OnEvent` por todo el proyecto y confiar en no dejarse ninguno.
 *
 * Aquí está la lista entera, en un sitio, y ese es justamente el objetivo de quitar
 * la magia: los efectos secundarios del sistema —avisar al abonado, registrar el
 * mensaje, actualizar una campaña— se leen de una vez.
 *
 * El orden no importa: el bus entrega a todos los suscriptores de un evento, y los
 * errores de cada uno se capturan por separado (ver `eventos.ts`).
 */
import { eventos } from './eventos';
import {
  avisosProactivosService,
  savesTransport,
  ticketConfirmacionService,
  cronService,
  whatsappCampaignService,
  whatsappInternalAlertListener,
  whatsappLogService,
  altaClienteService,
  ordenAlPagarService,
  avisoTecnicoService,
  equipoReservaService,
} from './contenedor';
import { ACTIVACION_APLICADA_EVENT, BAJA_APLICADA_EVENT, RECONEXION_APLICADA_ORDEN_EVENT, TICKET_ANULADA_EVENT, TICKET_ASIGNADO_EVENT, TICKET_DESASIGNADO_EVENT, TICKET_CREADO_EVENT, TICKET_RESUELTO_EVENT } from '../support/support.events';
import { CAJA_ABIERTA_EVENT, PAGO_APLICADO_EVENT } from '../treasury/treasury.events';
import { RECONEXION_APLICADA_EVENT } from '../network/network.events';
import { ESTADO_SERVICIO_EVENT } from '../subscribers/subscribers.events';
import {
  INTERNAL_ALERT_EVENT,
  WHATSAPP_INBOUND_EVENT,
  WHATSAPP_OUTBOUND_EVENT,
  WHATSAPP_STATUS_EVENT,
} from '../common/whatsapp/whatsapp.types';

export function registrarSuscripciones(): void {
  // --- Soporte ---------------------------------------------------------------
  // Al resolver un ticket se le pregunta al abonado si quedó conforme.
  eventos.on(TICKET_RESUELTO_EVENT, (e) => ticketConfirmacionService.alResolver(e as never), 'ticketConfirmacion');
  // Al asignar, se avisa por WhatsApp a quien corresponda.
  eventos.on(TICKET_ASIGNADO_EVENT, (e) => avisosProactivosService.alAsignar(e as never), 'avisosProactivos');
  // ...y al TÉCNICO le queda el aviso en su campanita: es lo único que se le notifica
  // de órdenes, y por eso cuelga del evento y no de los cuatro sitios que asignan.
  eventos.on(TICKET_ASIGNADO_EVENT, (e) => avisoTecnicoService.alAsignar(e as never), 'avisoTecnico');
  // ...y se le retira cuando la orden deja de ser suya sin pasar a otro. Reasignar no
  // pasa por aquí: `alAsignar` ya barre el aviso del anterior al crear el del nuevo.
  eventos.on(TICKET_DESASIGNADO_EVENT, (e) => avisoTecnicoService.alDesasignar((e as { ticketId: string }).ticketId), 'avisoTecnico');
  // La orden y su técnico salen hacia el legacy EN EL ACTO, sin esperar al cron de los
  // 5 minutos: los técnicos atienden desde allá, así que hasta que la orden no viaja no
  // existe para quien tiene que hacer la visita.
  eventos.on(TICKET_CREADO_EVENT, () => cronService.empujarOrdenesAlLegacy(), 'writebackOrdenes');
  eventos.on(TICKET_ASIGNADO_EVENT, () => cronService.empujarOrdenesAlLegacy(), 'writebackOrdenes');
  // Y si al cerrarla el abonado quedó RETIRADO o SUSPENDIDO, la baja sale en el acto:
  // el estado lo manda el legacy en la ida (cada 15 min), así que una baja que no llegue
  // antes se deshace sola y el cliente retirado vuelve a aparecer ACTIVO.
  eventos.on(BAJA_APLICADA_EVENT, () => cronService.empujarBajaAlLegacy(), 'writebackBajas');
  // Y si al cerrar la instalación quedó ACTIVO, la activación sale igual de rápido: el
  // legacy lo tiene en 'Instalar' y su ida devuelve ese estado cada 15 minutos, así que
  // sin este empuje el recién instalado vuelve solo a "por instalar".
  eventos.on(ACTIVACION_APLICADA_EVENT, () => cronService.empujarActivacionAlLegacy(), 'writebackActivacion');
  // Al abrir una instalación/cambio de equipo/migración/agregar internet/traslado se
  // aparta una unidad de la bodega de la sede a nombre del cliente, para que al
  // autenticar la ONU sea "el equipo que tiene asignado". Al cerrar o anular sin
  // haberla confirmado, vuelve a la bodega.
  eventos.on(TICKET_CREADO_EVENT, async (e: any) => { await equipoReservaService.reservarParaOrden(e.ticketId); }, 'reservaEquipo');
  eventos.on(TICKET_RESUELTO_EVENT, async (e: any) => { await equipoReservaService.liberarPorCierre(e.ticketId, 'RESUELTO'); }, 'reservaEquipo');
  eventos.on(TICKET_ANULADA_EVENT, async (e: any) => { await equipoReservaService.liberarPorCierre(e.ticketId, 'ANULADA'); }, 'reservaEquipo');

  // --- Tesorería -------------------------------------------------------------
  // Al aplicar un pago, el abonado recibe su confirmación.
  eventos.on(PAGO_APLICADO_EVENT, (e) => avisosProactivosService.alPagar(e as never), 'avisosProactivos');
  // ...y el cobro sale hacia el legacy EN EL ACTO, sin esperar al cron de los 5 minutos.
  // Mientras los dos sistemas convivan, un pago que aquí está y allá no es un abonado
  // que allá sigue debiendo: expuesto a corte y a que le vuelvan a cobrar en ventanilla.
  eventos.on(PAGO_APLICADO_EVENT, () => cronService.empujarCajaAlLegacy(), 'writebackCaja');
  // ...y si con ese pago quedó saldada la factura de AFILIACIÓN, nace la orden de
  // instalación: el técnico no va hasta que el cliente paga, y en cuanto paga no hay
  // que acordarse de abrirla a mano. Lo que se recauda en el legacy no pasa por aquí:
  // a esos los recoge el barrido de los 5 minutos (`instalaciones-pagadas`).
  eventos.on(PAGO_APLICADO_EVENT, async (e) => { await altaClienteService.alPagarAfiliacion((e as { subscriberId: string }).subscriberId); }, 'ordenInstalacion');
  // ...y lo mismo con cualquier OTRO trabajo que se cobre por adelantado: hoy el
  // TRASLADO, que se factura con la dirección nueva dentro y abre su orden en cuanto
  // el cliente paga (`PendingOrder`). Los pagos que entran por el legacy los recoge el
  // mismo barrido de los 5 minutos.
  eventos.on(PAGO_APLICADO_EVENT, async (e) => { await ordenAlPagarService.alPagar((e as { subscriberId: string }).subscriberId); }, 'ordenAlPagar');
  // Abrir la caja aquí la abre también allá. Es la misma pasada corta del cobro (ya
  // lleva el paso de aperturas), por eso no hace falta un empuje propio.
  eventos.on(CAJA_ABIERTA_EVENT, () => cronService.empujarCajaAlLegacy(), 'writebackCaja');

  // --- Red -------------------------------------------------------------------
  // Al devolverle el servicio a un abonado, el legacy tiene que enterarse EN EL ACTO:
  // su ida vuelve a traer `customers.usu_estado` cada 15 minutos y, si llega antes que
  // el writeback, deshace la reconexión —el cliente navegando y las dos pantallas
  // diciendo "Cortado"—. Es lo que le pasó a 35 de las 37 primeras reconexiones
  // automáticas (24-26 de agosto de 2026).
  eventos.on(RECONEXION_APLICADA_EVENT, () => cronService.empujarReconexionAlLegacy(), 'writebackReconexion');
  // La otra puerta por la que vuelve un servicio: el técnico (o la cajera) que CIERRA
  // una orden de reconexión. Tiene la misma prisa y la misma ida en contra, y hasta el
  // 09-09-2026 no empujaba nada — la reconexión se quedaba en este lado.
  eventos.on(RECONEXION_APLICADA_ORDEN_EVENT, () => cronService.empujarReconexionAlLegacy(), 'writebackReconexionOrden');
  // Y el corte de la FACTURA, que va por su propia puerta (`pushEstadoServicio`): la
  // reconexión de sólo televisión no le cambia el estado a nadie, así que
  // `pushReconexiones` no la ve y sólo esta pasada se lleva el `estado_tv` limpio.
  eventos.on(RECONEXION_APLICADA_ORDEN_EVENT, () => cronService.empujarEstadoServicioAlLegacy(), 'writebackEstadoServicioOrden');

  // --- Ficha del abonado -----------------------------------------------------
  // Mover a mano el estado de un servicio (su TV o su internet) tiene la misma prisa:
  // `invoices.estado_tv`/`estado_combo` los trae la ida cada 15 minutos, así que lo que
  // no llegue antes al legacy se borra solo y el servicio vuelve a pintarse al aire.
  eventos.on(ESTADO_SERVICIO_EVENT, () => cronService.empujarEstadoServicioAlLegacy(), 'writebackEstadoServicio');

  // --- WhatsApp --------------------------------------------------------------
  // Un mensaje entrante tiene DOS destinos, y los dos importan: el bot que lo
  // contesta y la bitácora de la conversación. Con `@OnEvent` esto quedaba repartido
  // en dos ficheros distintos y no se veía que compartían evento.
  eventos.on(WHATSAPP_INBOUND_EVENT, (m) => savesTransport.onWhatsappInbound(m as never), 'savesTransport');
  eventos.on(WHATSAPP_INBOUND_EVENT, (m) => whatsappLogService.onInbound(m as never), 'whatsappLog');

  eventos.on(WHATSAPP_OUTBOUND_EVENT, (e) => whatsappLogService.onOutbound(e as never), 'whatsappLog');

  // El estado de entrega alimenta la bitácora y el progreso de las campañas.
  eventos.on(WHATSAPP_STATUS_EVENT, (e) => whatsappLogService.onStatus(e as never), 'whatsappLog');
  eventos.on(WHATSAPP_STATUS_EVENT, (e) => whatsappCampaignService.onStatus(e as never), 'whatsappCampaign');

  // --- Alertas internas ------------------------------------------------------
  eventos.on(INTERNAL_ALERT_EVENT, (a) => whatsappInternalAlertListener.handle(a as never), 'alertaInterna');
}
