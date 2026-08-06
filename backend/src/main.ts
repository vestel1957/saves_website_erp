/**
 * Arranque de la API de SAVES.
 *
 * Sustituye al `main.ts` de NestJS. La diferencia de fondo no está en Express: está
 * en que aquí el arranque se lee de arriba abajo y en el orden en que ocurre —validar
 * entorno, cablear, suscribir, programar, escuchar—. Con Nest, buena parte de esto lo
 * hacía el framework por reflexión y no aparecía en ningún fichero.
 */
import 'reflect-metadata';
import { comprobarEntornoOAbortar } from './common/env.validation';
import { crearApp } from './core/app';
import { crearAuditoria } from './core/auditoria';
import { crearLimitador } from './core/http/limitador';
import { apagar, iniciar } from './core/ciclo-vida';
import { auditService, todosLosServicios } from './core/contenedor';
import { Logger } from './core/logger';
import { RUTAS } from './core/rutas';
import { registrarSuscripciones } from './core/suscripciones';
import { programarTareas } from './core/tareas';
import { detenerTodas } from './core/cron';

const log = new Logger('Arranque');

async function arrancar() {
  // Antes de levantar nada: si falta configuración crítica, fallar aquí y ruidoso.
  // Un proceso que arranca a medias es peor que uno que no arranca.
  comprobarEntornoOAbortar();

  // Ganchos de arranque de los servicios (entre ellos el `$connect` de Prisma). Si
  // alguno falla, el error sube y el proceso muere: que pm2 lo reintente es mejor
  // que servir peticiones contra una base a la que no se ha conectado.
  await iniciar(todosLosServicios);

  registrarSuscripciones();

  // Las programadas sólo se montan si están habilitadas. Cada tarea vuelve a
  // comprobarlo por dentro, pero no registrarlas siquiera evita que un despliegue de
  // pruebas tenga temporizadores vivos apuntando a la base de producción.
  if (process.env.CRONS_ENABLED === 'true') {
    programarTareas();
  } else {
    log.warn('Tareas programadas DESACTIVADAS (CRONS_ENABLED != true)');
  }

  const app = crearApp({
    rutas: RUTAS,
    auditoria: crearAuditoria(auditService),
    // Límite generoso a propósito: una oficina entera sale por la misma IP pública.
    limitador: crearLimitador({ limite: 600, ventanaMs: 60_000 }),
  });

  const puerto = process.env.PORT ? Number(process.env.PORT) : 4000;
  // Se escucha SÓLO en localhost: el único camino desde internet es el proxy TLS
  // (Plesk/Apache en 443 → 127.0.0.1), que ya termina el certificado. Exponer el
  // puerto además al 0.0.0.0 dejaba la API accesible por HTTP plano en
  // http://<ip>:3061, esquivando el TLS y mandando el token en claro.
  // `HOST=0.0.0.0` permite volver atrás sin tocar código si hiciera falta.
  const host = process.env.HOST ?? '127.0.0.1';

  const servidor = app.listen(puerto, host, () => {
    log.log(`🚀 API de SAVES escuchando en http://${host}:${puerto}/api`);
  });

  // Apagado ordenado. pm2 manda SIGINT al reiniciar: sin esto, las peticiones en
  // vuelo se cortan a mitad y las conexiones de Prisma quedan colgando en Postgres,
  // que está compartido con otras aplicaciones y tiene el cupo justo.
  const apagarOrdenado = (senal: string) => {
    log.log(`${senal} recibido: cerrando…`);
    detenerTodas();
    servidor.close(() => {
      void apagar(todosLosServicios).then(() => process.exit(0));
    });
    // Red de seguridad: si algo se queda colgado, no bloquear el reinicio.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => apagarOrdenado('SIGINT'));
  process.on('SIGTERM', () => apagarOrdenado('SIGTERM'));
}

void arrancar().catch((e) => {
  log.error(`No se pudo arrancar: ${(e as Error)?.message}`, (e as Error)?.stack);
  process.exit(1);
});
