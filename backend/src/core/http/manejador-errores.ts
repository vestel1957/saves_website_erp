/**
 * Manejador global de errores (sustituye a `AllExceptionsFilter`).
 *
 * Es un port fiel del filtro de Nest: MISMA traducción de códigos de Prisma, MISMA
 * forma del cuerpo (`statusCode`/`error`/`message`/extras/`path`/`timestamp`) y
 * mismo criterio de log (traza completa en 5xx, una línea en 4xx). El frontend ya
 * sabe leer esa forma; cambiarla al migrar habría roto los mensajes de error de
 * todas las pantallas sin que ningún test lo notara.
 */
import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../logger';
import { HttpException, textoDeEstado } from './errores';

const log = new Logger('Excepciones');

interface Traducción {
  status: number;
  message: string | string[];
  error: string;
  extra?: Record<string, unknown>;
}

/** Códigos de Prisma → HTTP. Sólo los que se dan de verdad en este proyecto. */
function traducirPrisma(e: Prisma.PrismaClientKnownRequestError): Traducción {
  const campos = (meta: unknown): string => {
    const t = (meta as { target?: string[] | string } | undefined)?.target;
    if (Array.isArray(t)) return t.join(', ');
    return typeof t === 'string' ? t : '';
  };

  switch (e.code) {
    case 'P2002': {
      // Unique constraint. El caso vivo es el consecutivo `tid` de los documentos.
      const c = campos(e.meta);
      return {
        status: 409,
        message: c
          ? `Ya existe un registro con ese valor en: ${c}.`
          : 'Ya existe un registro con esos datos.',
        error: 'Conflict',
      };
    }
    case 'P2025':
      return { status: 404, message: 'El registro no existe.', error: 'Not Found' };
    case 'P2003':
      return {
        status: 400,
        message: 'La operación referencia un registro que no existe.',
        error: 'Bad Request',
      };
    case 'P2014':
      return {
        status: 400,
        message: 'La operación rompería una relación existente.',
        error: 'Bad Request',
      };
    case 'P2034':
      // Interbloqueo o conflicto de serialización: es reintentable.
      return {
        status: 409,
        message: 'La operación chocó con otra simultánea. Vuelve a intentarlo.',
        error: 'Conflict',
      };
    default:
      return { status: 500, message: 'Error interno del servidor.', error: 'Internal Server Error' };
  }
}

function traducir(excepción: unknown): Traducción {
  // Las excepciones HTTP ya traen su status y su forma: se respetan tal cual para
  // no romper los mensajes que el frontend ya muestra.
  if (excepción instanceof HttpException) {
    const status = excepción.getStatus();
    const cuerpo = excepción.getResponse();
    if (typeof cuerpo === 'string') {
      return { status, message: cuerpo, error: textoDeEstado(status) };
    }
    const { message, error, statusCode, ...extra } = cuerpo as {
      message?: string | string[];
      error?: string;
      statusCode?: number;
      [k: string]: unknown;
    };
    return {
      status,
      message: message ?? excepción.message,
      error: error ?? textoDeEstado(status),
      extra: Object.keys(extra).length ? extra : undefined,
    };
  }

  if (excepción instanceof Prisma.PrismaClientKnownRequestError) {
    return traducirPrisma(excepción);
  }

  if (excepción instanceof Prisma.PrismaClientValidationError) {
    // Consulta mal construida: es un bug nuestro, pero devolver 500 con el texto
    // de Prisma filtraría la forma del modelo.
    return { status: 400, message: 'Consulta inválida.', error: 'Bad Request' };
  }

  return {
    status: 500,
    message: 'Error interno del servidor.',
    error: 'Internal Server Error',
  };
}

/**
 * Middleware de error de Express. Va montado EL ÚLTIMO, después de las rutas.
 * La firma de 4 argumentos es obligatoria: si se omite `next`, Express lo trata
 * como middleware normal y no le llega ningún error.
 */
export function manejadorDeErrores(
  excepción: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const { status, message, error, extra } = traducir(excepción);

  // 5xx es un fallo nuestro: traza completa. 4xx es de uso: una línea basta.
  const donde = `${req?.method} ${req?.originalUrl ?? req?.url}`;
  if (status >= 500) {
    log.error(`${donde} -> ${status}: ${message}`, (excepción as Error)?.stack);
  } else {
    log.warn(`${donde} -> ${status}: ${message}`);
  }

  // Si la respuesta ya empezó a enviarse (p.ej. un PDF a medias), no se puede
  // reescribir la cabecera: sólo cerrar.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(status).json({
    statusCode: status,
    error,
    message,
    ...extra,
    path: req?.originalUrl ?? req?.url,
    timestamp: new Date().toISOString(),
  });
}

/**
 * 404 de ruta no encontrada. Nest respondía con esta forma cuando ninguna ruta
 * casaba; Express, si no se le dice nada, devuelve un HTML de "Cannot GET /x" que
 * el frontend no sabe parsear.
 */
export function rutaNoEncontrada(req: Request, res: Response) {
  res.status(404).json({
    statusCode: 404,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    path: req.originalUrl ?? req.url,
    timestamp: new Date().toISOString(),
  });
}
