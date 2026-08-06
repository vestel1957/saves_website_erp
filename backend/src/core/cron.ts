/**
 * Planificador de tareas (sustituye a `@nestjs/schedule` y al decorador `@Cron`).
 *
 * Usa el paquete `cron` DIRECTAMENTE — que es exactamente el motor que
 * `@nestjs/schedule` llevaba dentro (v3.2.1, la misma que ya estaba instalada como
 * dependencia transitiva). Cambiar de arquitectura y de motor de horarios a la vez
 * habría metido en la misma entrega un riesgo que nadie quiere: estas diez tareas
 * facturan a 21.000 abonados, pasan gente a cartera y sincronizan con el legacy.
 * Mismo motor = mismas expresiones, mismo manejo de zona horaria, mismo
 * comportamiento en los cambios de hora.
 *
 * El registro deja de ser un decorador y pasa a ser una lista explícita, que además
 * arregla algo que con Nest no se veía: aquí se lee de un vistazo TODO lo que el
 * sistema hace solo y a qué hora.
 */
import { CronJob } from 'cron';
import { Logger } from './logger';

const log = new Logger('Cron');

/** Todas las programadas se anclan a la hora de Colombia, no a la del servidor.
 *  Sin esto, "día 1 a las 02:00" se corre en la zona del SO: facturar o pasar a
 *  cartera en la hora equivocada (incluso el día equivocado) es un riesgo fiscal. */
export const TZ = 'America/Bogota';

export interface TareaProgramada {
  nombre: string;
  expresion: string;
  ejecutar: () => Promise<unknown> | unknown;
}

const trabajos = new Map<string, CronJob>();

/**
 * Registra y arranca una tarea.
 *
 * El `try/catch` es imprescindible: `cron` no captura los rechazos del callback, así
 * que un fallo en la sincronización con el legacy —que ocurre cada 15 minutos y
 * depende de una base MySQL ajena— tumbaría el proceso entero de la API.
 */
export function programar(tarea: TareaProgramada): void {
  if (trabajos.has(tarea.nombre)) {
    throw new Error(`Tarea programada duplicada: ${tarea.nombre}`);
  }
  const job = new CronJob(
    tarea.expresion,
    () => {
      void (async () => {
        try {
          await tarea.ejecutar();
        } catch (e) {
          log.error(`[${tarea.nombre}] falló: ${(e as Error)?.message}`, (e as Error)?.stack);
        }
      })();
    },
    null,
    true, // arrancar de inmediato
    TZ,
  );
  trabajos.set(tarea.nombre, job);
}

/** Programa una lista de tareas y deja constancia en el log de qué quedó activo. */
export function programarTodas(tareas: TareaProgramada[]): void {
  for (const t of tareas) programar(t);
  log.log(`${tareas.length} tareas programadas (${TZ}): ${tareas.map((t) => t.nombre).join(', ')}`);
}

/** Detiene todas las tareas. Se usa en el apagado ordenado. */
export function detenerTodas(): void {
  for (const [nombre, job] of trabajos) {
    job.stop();
    trabajos.delete(nombre);
  }
}
