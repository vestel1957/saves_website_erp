/**
 * Tareas programadas (sustituyen al decorador `@Cron`).
 *
 * Diez automatizaciones que facturan a 21.000 abonados, pasan gente a Cartera y
 * sincronizan con el legacy. Antes eran diez decoradores sueltos dentro de
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
    expresion: '5,10,20,25,35,40,50,55 * * * *',
    ejecutar: () => cronService.scheduledLegacyCajaSync(),
  },
  {
    nombre: 'legacy-writeback',
    expresion: '7,22,37,52 * * * *',
    ejecutar: () => cronService.scheduledLegacyWriteback(),
  },
];

export function programarTareas(): void {
  programarTodas(TAREAS);
}
