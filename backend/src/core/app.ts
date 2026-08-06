/**
 * Construcción de la aplicación Express.
 *
 * Es el equivalente a lo que `NestFactory.create()` + `main.ts` hacían juntos, pero
 * escrito en el orden en que las cosas ocurren de verdad. Cada middleware conserva
 * la decisión —y el porqué— que ya estaba tomada en el `main.ts` de Nest: son
 * ajustes que se pagaron con incidentes, no valores por defecto.
 *
 * EL ORDEN DE ESTE FICHERO ES LA SEGURIDAD DE LA API. Se lee de arriba abajo:
 * proxy → compresión → cabeceras → CORS → cuerpo → límite de peticiones →
 * auditoría → rutas → 404 → errores.
 */
import express, { type Express, type Router } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { manejadorDeErrores, rutaNoEncontrada } from './http/manejador-errores';

export interface OpcionesApp {
  /** Routers ya montados, con su prefijo (sin `/api`, que se añade aquí). */
  rutas: Array<{ prefijo: string; router: Router }>;
  /** Middleware de auditoría, ya cableado con su servicio. */
  auditoria: express.RequestHandler;
  /** Middleware que limita peticiones por IP. */
  limitador: express.RequestHandler;
}

export function crearApp(opciones: OpcionesApp): Express {
  const app = express();

  // Confiar en UN proxy (Plesk/Apache en 127.0.0.1 → aquí). Sin esto, Express ve el
  // socket de loopback y `req.ip` es SIEMPRE 127.0.0.1 para todo internet, con lo que
  // el límite por IP (login y limitador global) trata a todos los clientes como uno
  // solo: 10 logins fallidos bloqueaban el login de TODA la empresa. Con esto,
  // `req.ip` toma el X-Forwarded-For que fija el proxy y el límite es por cliente
  // real. `1` = un único salto de confianza; NO usar `true`, que confiaría en un
  // XFF falsificado.
  app.set('trust proxy', 1);

  // Express añade `X-Powered-By: Express` — dice al mundo qué se está corriendo sin
  // aportar nada. Nest no la mandaba.
  app.disable('x-powered-by');

  // Comprime las respuestas (gzip). Los listados JSON viajan ~5-8x más livianos.
  app.use(compression());

  // Cabeceras de seguridad. Dos ajustes conscientes sobre los valores por defecto:
  //  - `crossOriginResourcePolicy` en 'cross-origin': el frontend corre en otro
  //    puerto (3060) que la API (3061), o sea otro origen. Con el 'same-origin' que
  //    trae helmet por defecto, el navegador bloquearía los adjuntos y PDFs.
  //  - CSP desactivada: esta app sólo sirve JSON y ficheros de descarga, nunca HTML
  //    propio, así que una CSP aquí no protege nada y sí puede romper clientes.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
      credentials: true,
    }),
  );

  // El webhook de WhatsApp verifica la firma X-Hub-Signature-256 sobre el cuerpo
  // EXACTO que llegó. Si se parsea y se vuelve a serializar, el byte a byte cambia y
  // la firma no cuadra nunca. Nest resolvía esto con `rawBody: true`; aquí se guarda
  // el buffer crudo en `req.rawBody` mientras se parsea con normalidad.
  const guardarCrudo = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };

  // Límite de 10 MB: los adjuntos van por multipart (multer, con sus propios topes),
  // pero las masivas de WhatsApp y las importaciones de pagos mandan JSON grande.
  app.use(express.json({ limit: '10mb', verify: guardarCrudo }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Límite global de peticiones. Va DESPUÉS del parseo del cuerpo y ANTES de las
  // rutas, en el mismo punto donde el ThrottlerGuard global de Nest actuaba.
  app.use(opciones.limitador);

  // Bitácora: debe ver `req.body` ya parseado y engancharse antes que los handlers.
  app.use(opciones.auditoria);

  // Todas las rutas cuelgan de /api, como hacía `setGlobalPrefix('api')`.
  for (const { prefijo, router } of opciones.rutas) {
    app.use(`/api/${prefijo}`.replace(/\/+$/, ''), router);
  }

  // Una ruta inexistente devuelve el mismo JSON que devolvía Nest, no el HTML de
  // "Cannot GET /x" de Express, que el frontend no sabe leer.
  app.use(rutaNoEncontrada);

  // El manejador de errores va SIEMPRE el último y con sus 4 argumentos.
  app.use(manejadorDeErrores);

  return app;
}
