import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * Filtro global de excepciones.
 *
 * Antes no había ninguno (`@Catch` no aparecía en todo el proyecto), así que los
 * errores de Prisma salían como **500 con stack trace**: el cliente no podía
 * distinguir "ese consecutivo ya existe" de "la base se cayó", y el detalle interno
 * (nombre de tabla, columna, constraint) viajaba al navegador.
 *
 * Traduce los códigos de Prisma al HTTP que les corresponde y deja el resto en 500
 * con un mensaje genérico, registrando la traza completa en el log del servidor.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Excepciones');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, message, error } = this.traducir(exception);

    // 5xx es un fallo nuestro: traza completa. 4xx es de uso: una línea basta.
    const donde = `${req?.method} ${req?.originalUrl ?? req?.url}`;
    if (status >= 500) {
      this.log.error(`${donde} -> ${status}: ${message}`, (exception as Error)?.stack);
    } else {
      this.log.warn(`${donde} -> ${status}: ${message}`);
    }

    // Si la respuesta ya empezó a enviarse (p.ej. un res.sendFile a medias), no se
    // puede reescribir la cabecera: sólo cerrar.
    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(status).json({
      statusCode: status,
      error,
      message,
      path: req?.originalUrl ?? req?.url,
      timestamp: new Date().toISOString(),
    });
  }

  private traducir(exception: unknown): { status: number; message: string | string[]; error: string } {
    // Las excepciones de Nest ya traen su status y su forma: se respetan tal cual
    // para no romper los mensajes que el frontend ya muestra.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const cuerpo = exception.getResponse();
      if (typeof cuerpo === 'string') {
        return { status, message: cuerpo, error: HttpStatus[status] ?? 'Error' };
      }
      const c = cuerpo as { message?: string | string[]; error?: string };
      return {
        status,
        message: c.message ?? exception.message,
        error: c.error ?? (HttpStatus[status] ?? 'Error'),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.traducirPrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
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

  /** Códigos de Prisma → HTTP. Sólo los que se dan de verdad en este proyecto. */
  private traducirPrisma(e: Prisma.PrismaClientKnownRequestError) {
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
          message: c ? `Ya existe un registro con ese valor en: ${c}.` : 'Ya existe un registro con esos datos.',
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
}
