import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Lo importante aquí es doble: que los errores de Prisma dejen de salir como 500, y
 * que las excepciones de Nest sigan saliendo EXACTAMENTE igual que antes — el frontend
 * ya lee esos mensajes y el filtro no puede cambiarles la forma.
 */

const contexto = () => {
  const json = jest.fn();
  const end = jest.fn();
  const res = { status: jest.fn(() => ({ json })), json, end, headersSent: false };
  const req = { method: 'GET', originalUrl: '/api/prueba' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  return { host, res, json };
};

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('mensaje interno de prisma', {
    code,
    clientVersion: '6.0.0',
    meta,
  });

describe('AllExceptionsFilter', () => {
  let filtro: AllExceptionsFilter;
  beforeEach(() => {
    filtro = new AllExceptionsFilter();
    jest.spyOn(filtro['log'], 'error').mockImplementation(() => undefined);
    jest.spyOn(filtro['log'], 'warn').mockImplementation(() => undefined);
  });

  it('P2002 (unique) -> 409 nombrando el campo, no 500', () => {
    const { host, res, json } = contexto();
    filtro.catch(prismaError('P2002', { target: ['tid'] }), host as never);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].message).toContain('tid');
  });

  it('P2025 (no existe) -> 404', () => {
    const { host, res } = contexto();
    filtro.catch(prismaError('P2025'), host as never);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('P2003 (clave foránea) -> 400', () => {
    const { host, res } = contexto();
    filtro.catch(prismaError('P2003'), host as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('P2034 (interbloqueo) -> 409 e invita a reintentar', () => {
    const { host, res, json } = contexto();
    filtro.catch(prismaError('P2034'), host as never);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].message).toMatch(/intentarlo/i);
  });

  it('un código de Prisma desconocido no filtra el mensaje interno', () => {
    const { host, res, json } = contexto();
    filtro.catch(prismaError('P9999'), host as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).not.toContain('prisma');
  });

  it('un error cualquiera -> 500 genérico, sin filtrar el mensaje original', () => {
    const { host, res, json } = contexto();
    filtro.catch(new Error('connect ECONNREFUSED 10.0.0.5:8728'), host as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json.mock.calls[0][0].message).toBe('Error interno del servidor.');
  });

  it.each([
    [new NotFoundException('Cliente no encontrado'), 404, 'Cliente no encontrado'],
    [new ForbiddenException('No tienes acceso a esta caja.'), 403, 'No tienes acceso a esta caja.'],
    [new BadRequestException('El monto debe ser mayor a cero'), 400, 'El monto debe ser mayor a cero'],
  ])('respeta las excepciones de Nest tal cual (%#)', (exc, status, mensaje) => {
    const { host, res, json } = contexto();
    filtro.catch(exc, host as never);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(json.mock.calls[0][0].message).toBe(mensaje);
  });

  it('conserva la lista de mensajes del ValidationPipe', () => {
    const { host, json } = contexto();
    filtro.catch(new BadRequestException(['email must be an email']), host as never);
    expect(json.mock.calls[0][0].message).toEqual(['email must be an email']);
  });

  it('si la respuesta ya empezó a enviarse, no intenta reescribir la cabecera', () => {
    const { host, res } = contexto();
    res.headersSent = true;
    filtro.catch(new Error('boom'), host as never);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
