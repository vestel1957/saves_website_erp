import { SubscribersController } from './subscribers.controller';
import { KIND_VIVIENDA } from './subscriber-file-kinds';

/**
 * La FICHA REDUCIDA del técnico de paso (2026-09-12).
 *
 * Qué se fija aquí, que es justo lo que un descuido convertiría en un agujero: al
 * cliente que NO es de sus órdenes el técnico llega para **una sola cosa**, la foto
 * de la vivienda. Si mañana alguien cambia `detail` y devuelve la ficha completa, o
 * deja de filtrar los adjuntos, por esa misma puerta se van el teléfono, la deuda,
 * la cédula escaneada y la carta de retiro de los 21.906 abonados — que es
 * exactamente lo que se cerró el 2026-09-10.
 */

const controlador = (opciones: {
  limitada: boolean;
  archivos?: { id: string; kind: string | null }[];
  meta?: { kind: string | null; storedName: string; mimeType: string; originalName: string };
}) => {
  const subscribers = {
    fichaLimitada: jest.fn().mockResolvedValue(opciones.limitada),
    fichaReducida: jest.fn().mockResolvedValue({ id: 's1', name: 'ANA PEREZ', limitado: true }),
    detail: jest.fn().mockResolvedValue({ id: 's1', name: 'ANA PEREZ', phone1: '3001234567', receivable: 90000 }),
    exigirSuCliente: jest.fn().mockResolvedValue(undefined),
  };
  const files = {
    listFiles: jest.fn().mockResolvedValue(opciones.archivos ?? []),
    addFile: jest.fn().mockResolvedValue({ id: 'f9' }),
    fileMeta: jest.fn().mockResolvedValue(opciones.meta ?? null),
  };
  const ctrl = new SubscribersController(
    subscribers as never, {} as never, files as never, {} as never, {} as never, {} as never,
  );
  return { ctrl, subscribers, files };
};

const TECNICO = { id: 'u1', permissions: ['area.tecnicos'] } as never;
const FOTO = { originalname: 'casa.jpg', filename: 'x.jpg', mimetype: 'image/jpeg', size: 10, path: '/tmp/x.jpg' };

describe('ficha del cliente que no es de sus órdenes', () => {
  it('el técnico de paso recibe la ficha REDUCIDA, no un 403', async () => {
    const { ctrl, subscribers } = controlador({ limitada: true });
    await expect(ctrl.detail('s1', TECNICO)).resolves.toEqual({ id: 's1', name: 'ANA PEREZ', limitado: true });
    expect(subscribers.detail).not.toHaveBeenCalled();
  });

  it('con el cliente de su propia orden sigue viendo la ficha completa', async () => {
    const { ctrl, subscribers } = controlador({ limitada: false });
    await expect(ctrl.detail('s1', TECNICO)).resolves.toHaveProperty('phone1', '3001234567');
    expect(subscribers.fichaReducida).not.toHaveBeenCalled();
  });

  it('de los adjuntos sólo le llegan las fotos de la vivienda', async () => {
    const { ctrl } = controlador({
      limitada: true,
      archivos: [
        { id: 'f1', kind: KIND_VIVIENDA },
        { id: 'f2', kind: 'CARTA_RETIRO' },
        { id: 'f3', kind: 'IDENTIDAD' },
        { id: 'f4', kind: null },
      ],
    });
    await expect(ctrl.listFiles('s1', TECNICO)).resolves.toEqual([{ id: 'f1', kind: KIND_VIVIENDA }]);
  });

  it('la ficha completa sigue entregando TODOS los adjuntos', async () => {
    const { ctrl } = controlador({
      limitada: false,
      archivos: [{ id: 'f1', kind: KIND_VIVIENDA }, { id: 'f2', kind: 'CARTA_RETIRO' }],
    });
    await expect(ctrl.listFiles('s1', TECNICO)).resolves.toHaveLength(2);
  });

  it('no puede bajarse la cédula escaneada de un cliente que no es suyo', async () => {
    const { ctrl } = controlador({
      limitada: true,
      meta: { kind: 'IDENTIDAD', storedName: 'x.pdf', mimeType: 'application/pdf', originalName: 'cc.pdf' },
    });
    await expect(ctrl.download('s1', 'f2', {} as never, TECNICO)).rejects.toThrow(/sólo puedes ver la foto de la vivienda/);
  });

  it('la foto de la vivienda sí la baja (es como se PINTA en la ficha)', async () => {
    const { ctrl } = controlador({
      limitada: true,
      meta: { kind: KIND_VIVIENDA, storedName: 'no-existe.jpg', mimeType: 'image/jpeg', originalName: 'casa.jpg' },
    });
    // Pasa el permiso; se cae después, al no estar el binario en disco.
    await expect(ctrl.download('s1', 'f1', {} as never, TECNICO)).rejects.toThrow(/no está en el servidor/);
  });

  it('la foto de la vivienda se puede subir a CUALQUIER cliente', async () => {
    const { ctrl, files } = controlador({ limitada: true });
    await expect(ctrl.uploadHousePhoto('s1', FOTO as never, TECNICO)).resolves.toEqual({ id: 'f9' });
    expect(files.addFile).toHaveBeenCalledWith('s1', FOTO, undefined, TECNICO, KIND_VIVIENDA);
  });
});
