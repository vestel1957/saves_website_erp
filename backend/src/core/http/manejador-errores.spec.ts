import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { manejadorDeErrores } from './manejador-errores';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from './errores';

/**
 * Estos casos vienen del spec del `AllExceptionsFilter` de Nest, reapuntados al
 * manejador de Express. Se conservan uno a uno a propósito: son la comprobación de
 * que la migración NO cambió lo que ve el cliente. Si el port se hubiera desviado,
 * es aquí donde tiene que doler.
 *
 * Lo importante es doble: que los errores de Prisma sigan sin salir como 500, y que
 * las excepciones HTTP salgan EXACTAMENTE igual que antes — el frontend ya lee esos
 * mensajes y un cambio de framework no puede cambiarles la forma.
 */

const contexto = () => {
  const json = jest.fn();
  const end = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status, json, end, headersSent: false } as unknown as Response;
  const req = { method: 'GET', originalUrl: '/api/prueba' } as unknown as Request;
  return { req, res, json, status, end };
};

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('mensaje interno de prisma', {
    code,
    clientVersion: '6.0.0',
    meta,
  });

/** El manejador registra en consola; se silencia para no ensuciar la salida. */
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const lanzar = (error: unknown, ctx = contexto()) => {
  manejadorDeErrores(error, ctx.req, ctx.res, jest.fn());
  return ctx;
};

describe('traducción de errores de Prisma', () => {
  it('P2002 (unique) -> 409 nombrando el campo, no 500', () => {
    const { status, json } = lanzar(prismaError('P2002', { target: ['tid'] }));
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].message).toContain('tid');
  });

  it('P2025 (no existe) -> 404', () => {
    expect(lanzar(prismaError('P2025')).status).toHaveBeenCalledWith(404);
  });

  it('P2003 (clave foránea) -> 400', () => {
    expect(lanzar(prismaError('P2003')).status).toHaveBeenCalledWith(400);
  });

  it('P2034 (interbloqueo) -> 409 e invita a reintentar', () => {
    const { status, json } = lanzar(prismaError('P2034'));
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].message).toMatch(/intentarlo/i);
  });

  it('un código de Prisma desconocido no filtra el mensaje interno', () => {
    const { status, json } = lanzar(prismaError('P9999'));
    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).not.toContain('prisma');
  });
});

describe('errores no controlados', () => {
  it('un error cualquiera -> 500 genérico, sin filtrar el mensaje original', () => {
    const { status, json } = lanzar(new Error('connect ECONNREFUSED 10.0.0.5:8728'));
    expect(status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).toBe('Error interno del servidor.');
  });

  it('si la respuesta ya empezó a enviarse, no intenta reescribir la cabecera', () => {
    const ctx = contexto();
    (ctx.res as { headersSent: boolean }).headersSent = true;
    lanzar(new Error('boom'), ctx);
    expect(ctx.status).not.toHaveBeenCalled();
    expect(ctx.end).toHaveBeenCalled();
  });
});

describe('excepciones HTTP', () => {
  it.each([
    [new NotFoundException('Cliente no encontrado'), 404, 'Cliente no encontrado'],
    [new ForbiddenException('No tienes acceso a esta caja.'), 403, 'No tienes acceso a esta caja.'],
    [new BadRequestException('El monto debe ser mayor a cero'), 400, 'El monto debe ser mayor a cero'],
  ])('se respetan tal cual (%#)', (exc, status, mensaje) => {
    const ctx = lanzar(exc);
    expect(ctx.status).toHaveBeenCalledWith(status);
    expect(ctx.json.mock.calls[0][0].message).toBe(mensaje);
  });

  it('conserva la lista de mensajes de la validación', () => {
    const { json } = lanzar(new BadRequestException(['email must be an email']));
    expect(json.mock.calls[0][0].message).toEqual(['email must be an email']);
  });

  it('conserva los campos extra que adjunta una excepción de negocio', () => {
    // La geo-cerca manda `code`/`distanciaM` para que el frontend pueda ofrecer
    // justificar en vez de sólo enseñar un texto de error.
    const { json } = lanzar(
      new HttpException(
        { code: 'GEOFENCE', message: 'Estás lejos', distanciaM: 2944, radioM: 100 },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        message: 'Estás lejos',
        code: 'GEOFENCE',
        distanciaM: 2944,
        radioM: 100,
      }),
    );
  });
});
