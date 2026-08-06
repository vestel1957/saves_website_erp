/**
 * Pruebas del núcleo Express.
 *
 * No comprueban que el código "funcione" en abstracto: comprueban las cuatro cosas
 * que un cambio de framework rompe en silencio y que el frontend ya da por hechas.
 * Cada una de ellas se rompió alguna vez en algún port, y ninguna la habría cazado
 * el compilador.
 *
 *   1. POST responde 201 (Nest lo hacía; Express, por su cuenta, responde 200).
 *   2. El 400 de validación trae `message` como ARRAY de strings — así es como los
 *      formularios señalan el campo que falla.
 *   3. `whitelist` descarta las propiedades no declaradas (anti asignación masiva).
 *   4. El cuerpo del error mantiene statusCode/error/message/path/timestamp y los
 *      campos extra que la excepción adjunte.
 *
 * Se levanta un servidor real en un puerto efímero y se le habla con `fetch`: sin
 * supertest, que no está instalado, y probando el camino completo de Express en vez
 * de llamar a los middlewares a mano.
 */
import 'reflect-metadata';
import express from 'express';
import type { Server } from 'node:http';
import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { manejar } from './http/ruta';
import { validar } from './http/validar';
import { manejadorDeErrores, rutaNoEncontrada } from './http/manejador-errores';
import { BadRequestException, ForbiddenException, NotFoundException } from './http/errores';

class CrearCosaDto {
  @IsString()
  @MinLength(3)
  nombre!: string;

  @IsOptional()
  @IsInt()
  cantidad?: number;
}

let servidor: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  app.get('/cosas', manejar(() => [{ id: 1 }]));
  app.post('/cosas', manejar((req) => ({ recibido: validar(CrearCosaDto, req.body) })));
  app.get('/vacio', manejar(() => undefined));
  app.get('/falta', manejar(() => {
    throw new NotFoundException('El abonado no existe.');
  }));
  app.get('/negocio', manejar(() => {
    // Error con campos accionables: el frontend distingue el caso por `code`,
    // no comparando el texto del mensaje.
    throw new BadRequestException({ message: 'Estás lejos de la vivienda.', code: 'GEOFENCE', distancia: 812 });
  }));
  app.get('/prohibido', manejar(() => {
    throw new ForbiddenException();
  }));
  app.get('/stream', manejar((_req, res) => {
    res.type('text/plain').send('contenido crudo');
  }));

  app.use(rutaNoEncontrada);
  app.use(manejadorDeErrores);

  await new Promise<void>((listo) => {
    servidor = app.listen(0, '127.0.0.1', () => listo());
  });
  const dir = servidor.address() as { port: number };
  base = `http://127.0.0.1:${dir.port}`;
});

afterAll(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
});

describe('código de estado por defecto', () => {
  it('GET responde 200', async () => {
    const r = await fetch(`${base}/cosas`);
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual([{ id: 1 }]);
  });

  it('POST responde 201, como hacía Nest', async () => {
    const r = await fetch(`${base}/cosas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'router' }),
    });
    expect(r.status).toBe(201);
  });

  it('un handler que no devuelve nada no rompe al cliente', async () => {
    const r = await fetch(`${base}/vacio`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
  });

  it('si el handler ya escribió (stream/PDF), no se le pisa la respuesta', async () => {
    const r = await fetch(`${base}/stream`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('contenido crudo');
  });
});

describe('validación', () => {
  it('devuelve 400 con `message` como array de strings', async () => {
    const r = await fetch(`${base}/cosas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'ab' }),
    });
    expect(r.status).toBe(400);
    const cuerpo = await r.json();
    expect(Array.isArray(cuerpo.message)).toBe(true);
    expect(cuerpo.message.join(' ')).toMatch(/nombre/);
    expect(cuerpo.error).toBe('Bad Request');
  });

  it('exige el cuerpo aunque no llegue ninguno', async () => {
    const r = await fetch(`${base}/cosas`, { method: 'POST' });
    expect(r.status).toBe(400);
  });

  it('descarta propiedades no declaradas (asignación masiva)', async () => {
    const r = await fetch(`${base}/cosas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'router', rol: 'superadmin', esAdmin: true }),
    });
    const cuerpo = await r.json();
    expect(cuerpo.recibido).toEqual({ nombre: 'router' });
    expect(cuerpo.recibido.rol).toBeUndefined();
  });

  it('convierte los tipos igual que la conversión implícita de Nest', async () => {
    const r = await fetch(`${base}/cosas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: 'router', cantidad: '42' }),
    });
    const cuerpo = await r.json();
    expect(cuerpo.recibido.cantidad).toBe(42);
  });
});

describe('forma del error', () => {
  it('conserva statusCode/error/message/path/timestamp', async () => {
    const r = await fetch(`${base}/falta`);
    expect(r.status).toBe(404);
    const cuerpo = await r.json();
    expect(cuerpo).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      message: 'El abonado no existe.',
      path: '/falta',
    });
    expect(typeof cuerpo.timestamp).toBe('string');
  });

  it('conserva los campos extra de un error de negocio', async () => {
    const cuerpo = await (await fetch(`${base}/negocio`)).json();
    expect(cuerpo).toMatchObject({ statusCode: 400, code: 'GEOFENCE', distancia: 812 });
  });

  it('usa el mensaje por defecto cuando la excepción no trae uno', async () => {
    const cuerpo = await (await fetch(`${base}/prohibido`)).json();
    expect(cuerpo).toMatchObject({ statusCode: 403, error: 'Forbidden' });
    expect(cuerpo.message).toBeTruthy();
  });

  it('una ruta inexistente devuelve JSON, no el HTML de Express', async () => {
    const r = await fetch(`${base}/no-existe`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    await expect(r.json()).resolves.toMatchObject({ statusCode: 404 });
  });
});
