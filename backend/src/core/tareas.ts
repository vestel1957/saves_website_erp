/**
 * Tareas programadas (sustituyen al decorador `@Cron`).
 *
 * Catorce automatizaciones que facturan a 21.000 abonados, pasan gente a Cartera,
 * sincronizan con el legacy y cuadran su caja contra la nuestra. Antes eran diez decoradores sueltos dentro de
 * `CronService`; aquí son una lista, con su horario y su porqué al lado.
 *
 * Las expresiones son EXACTAMENTE las que había, incluida la de `exchange-rate`, que
 * usaba la constante `CronExpression.EVERY_DAY_AT_4AM` de Nest y vale `0 04 * * *`.
 * Todas corren en hora de Colombia (ver `TZ` en `cron.ts`): anclarlas a la zona del
 * servidor haría que facturar el "día 1 a las 02:00" cayera en el día equivocado.
 *
 * Las tareas comprueban `CRONS_ENABLED` cada una por dentro, igual que antes; la que
 * hace la foto diaria de métricas corre siempre, a propósito, porque un día perdido
 * del histórico no se puede reconstruir.
 */
import { cronService } from './contenedor';
import { programarTodas, type TareaProgramada } from './cron';

export const TAREAS: TareaProgramada[] = [
  {
    nombre: 'recurring-billing',
    expresion: '0 2 1 * *', // día 1 de cada mes, 02:00
    ejecutar: () => cronService.scheduledRecurringBilling(),
  },
  {
    nombre: 'agenda-arrastre',
    // Diario 00:05 — lo que un técnico no alcanzó a resolver pasa al día siguiente.
    // La primera de la madrugada: la agenda tiene que estar puesta antes de que
    // alguien abra su panel, y no toca dinero (no compite con la facturación).
    expresion: '5 0 * * *',
    ejecutar: () => cronService.scheduledAgendaArrastre(),
  },
  {
    nombre: 'metrics-snapshot',
    expresion: '20 0 * * *', // diario 00:20 — antes de que nada mueva los estados
    ejecutar: () => cronService.scheduledMetrics(),
  },
  {
    nombre: 'cartera',
    expresion: '0 3 * * *',
    ejecutar: () => cronService.scheduledCartera(),
  },
  {
    nombre: 'geo-purge',
    expresion: '40 3 * * *',
    ejecutar: () => cronService.scheduledGeoPurge(),
  },
  {
    nombre: 'secrets-al-dia',
    // Diaria 04:30 — pone el /ppp/secret de cada abonado de acuerdo con su ficha
    // (comentario con la VLAN, IP local, IP remota que falte). Es lo que evita que
    // el desfase con el legacy se vaya acumulando hasta que alguien lo note en un
    // cliente suelto. No reinicia sesiones ni toca clave, usuario ni perfil.
    expresion: '30 4 * * *',
    ejecutar: () => cronService.scheduledSecretsAlDia(),
  },
  {
    nombre: 'cortes-deshechos',
    // Diaria 07:00 — antes de que abra la oficina. Avisa a Cartera de los cortados por
    // mora que un router volvió a dejar navegando sin pago ni reconexión (el 01-09-2026
    // pasó con 23 a la vez y nadie lo supo en dos semanas). Sólo lee los routers.
    expresion: '0 7 * * *',
    ejecutar: () => cronService.scheduledCortesDeshechos(),
  },
  {
    nombre: 'exchange-rate',
    expresion: '0 04 * * *', // era CronExpression.EVERY_DAY_AT_4AM
    ejecutar: () => cronService.scheduledExchangeRate(),
  },
  {
    nombre: 'reminders',
    expresion: '0 6 * * *',
    ejecutar: () => cronService.scheduledReminders(),
  },
  {
    nombre: 'wa-reminders',
    expresion: '0 9 * * *',
    ejecutar: () => cronService.scheduledWaReminders(),
  },
  {
    nombre: 'legacy-sync',
    expresion: '*/15 * * * *',
    ejecutar: () => cronService.scheduledLegacySync(),
  },
  {
    nombre: 'legacy-sync-caja',
    // Cada 20 SEGUNDOS (expresión de 6 campos). Sólo lee `transactions` por encima del
    // watermark: 200 ms de trabajo, 0,45 s de proceso. A 5 minutos, un cobro hecho en el
    // legacy tardaba hasta 5 minutos en verse aquí; así se ve en 20 segundos. Comparte
    // el cerrojo `legacySyncRunning` con la completa, así que nunca se pisan.
    expresion: '*/20 * * * * *',
    ejecutar: () => cronService.scheduledLegacyCajaSync(),
  },
  {
    nombre: 'conciliacion-caja',
    // Diaria a las 21:00, cuando las cajas del día ya cerraron. Mira 7 días hacia
    // atrás a propósito: un borrado del legacy puede ocurrir días después del cobro.
    expresion: '0 21 * * *',
    ejecutar: () => cronService.scheduledConciliacionCaja(),
  },
  {
    nombre: 'instalaciones-pagadas',
    // Cada 5 min. La orden de instalación de quien pagó AQUÍ ya nació con el recaudo
    // (evento `treasury.pago.aplicado`); esto recoge a quien pagó EN EL LEGACY —su
    // pago llega por el sync, sin evento— y los intentos que fallaron.
    expresion: '*/5 * * * *',
    ejecutar: () => cronService.scheduledInstalacionesPagadas(),
  },
  {
    nombre: 'pagos-en-linea',
    // Cada 5 min, en los minutos impares que dejan libres las dos idas del legacy.
    // Trae del portal (`vestel.com.co/crm`) los pagos en línea y le devuelve el
    // servicio a quien pagó por ahí: el legacy solo reconecta internet —y solo si la
    // factura es del mes corriente—, la TV la deja siempre para una visita.
    expresion: '3,8,13,18,23,28,33,38,43,48,53,58 * * * *',
    ejecutar: () => cronService.scheduledPagosEnLinea(),
  },
  {
    nombre: 'descuento-portal',
    // Cada hora, en el minuto 40 (libre entre las dos idas y el writeback). Deja la
    // cartera ya rebajada para que el PORTAL DE PAGOS cobre con el descuento puesto, y
    // lo retira cuando la promoción vence sin pago. Gate propio
    // `PROMO_PORTAL_PRECONCEDER_LIVE`: cerrado, sólo calcula.
    expresion: '40 * * * *',
    ejecutar: () => cronService.scheduledDescuentoPortal(),
  },
  {
    nombre: 'legacy-writeback',
    // Cada 5 min, en los minutos que las dos idas dejan libres (ver el porqué en
    // `CronService.scheduledLegacyWriteback`).
    expresion: '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
    ejecutar: () => cronService.scheduledLegacyWriteback(),
  },
];

export function programarTareas(): void {
  programarTodas(TAREAS);
}
