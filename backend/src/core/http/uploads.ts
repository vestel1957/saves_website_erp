/**
 * Subida de ficheros (sustituye a `FileInterceptor` de `@nestjs/platform-express`).
 *
 * `FileInterceptor('file', opciones)` no era más que una envoltura sobre
 * `multer(opciones).single('file')`. Los 11 endpoints de subida ya configuran su
 * `diskStorage`, su `fileFilter` y sus límites a mano, así que aquí sólo se quita la
 * envoltura: la configuración de cada ruta se queda tal cual estaba.
 *
 * El fichero pasa a leerse de `req.file` en vez de recibirse por `@UploadedFile()`.
 */
import multer, { type Options } from 'multer';
import type { Request, RequestHandler } from 'express';
import { BadRequestException } from './errores';

/**
 * Opciones de subida.
 *
 * Es `Options` de multer con el `fileFilter` relajado. Los tipos de multer declaran
 * su callback con dos sobrecargas —`(error: null, aceptar: boolean)` y `(error:
 * Error)`— que no admiten el `cb(ok ? null : new BadRequestException(...), ok)` de
 * una sola línea que usan los 11 endpoints de subida del proyecto. Con Nest no daba
 * la cara porque el tipo lo ponía `MulterOptions`, que sí acepta `Error | null`.
 *
 * Relajar el tipo aquí evita reescribir esos filtros, que son los que comprueban el
 * MIME de verdad; tocarlos por un problema de tipos sería arriesgar la validación de
 * adjuntos por una cuestión de forma.
 */
export type OpcionesSubida = Omit<Options, 'fileFilter'> & {
  fileFilter?: (
    req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, aceptar?: boolean) => void,
  ) => void;
};

/** Un fichero subido. Igual que `Express.Multer.File`, con nombre propio para no
 *  arrastrar el espacio de nombres de Express por los controladores. */
export type FicheroSubido = Express.Multer.File;

/**
 * Middleware de subida de UN fichero.
 *
 *   router.post('/:id/foto', autenticar, subirUno('file', opcionesFoto),
 *     manejar((req) => servicio.guardar(req.params.id, req.file)));
 *
 * Traduce los errores de multer a 400 con un mensaje legible. Sin esto, superar el
 * límite de tamaño devolvía un 500 con el código interno `LIMIT_FILE_SIZE`, que al
 * usuario no le dice que su foto pesa demasiado.
 */
export function subirUno(campo: string, opciones: OpcionesSubida): RequestHandler {
  const subida = multer(opciones as Options).single(campo);
  return (req, res, next) => {
    subida(req, res, (err: unknown) => {
      if (!err) return next();
      const codigo = (err as { code?: string }).code;
      if (codigo === 'LIMIT_FILE_SIZE') {
        return next(new BadRequestException('El fichero supera el tamaño máximo permitido.'));
      }
      if (codigo === 'LIMIT_UNEXPECTED_FILE') {
        return next(new BadRequestException(`Se esperaba el campo de fichero "${campo}".`));
      }
      // Los `fileFilter` del proyecto rechazan lanzando su propia excepción HTTP
      // (MIME no permitido); esas pasan tal cual al manejador de errores.
      next(err);
    });
  };
}

/** Exige que la petición traiga fichero. Los handlers lo daban por hecho porque
 *  `@UploadedFile()` tipaba no-nulo, pero multer deja `req.file` en `undefined` si
 *  el cliente no envía nada, y el fallo aparecía luego como "cannot read property
 *  path of undefined" dentro del servicio. */
export function ficheroDe(req: { file?: FicheroSubido }): FicheroSubido {
  if (!req.file) throw new BadRequestException('No se recibió ningún fichero.');
  return req.file;
}
