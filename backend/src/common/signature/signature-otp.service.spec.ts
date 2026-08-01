import { SignatureOtpService } from './signature-otp.service';
import { verifyPassword } from '../../auth/crypto.util';

/**
 * Lo que se fija aquí es la MECÁNICA de la firma, que es donde un descuido no se
 * nota hasta que alguien la usa mal: que el código no se guarde en claro, que
 * sirva una sola vez, que no se pueda tantear a fuerza de intentos, y que un
 * código de una orden no firme otra. Todo lo demás (el texto del WhatsApp, la
 * plantilla) puede cambiar sin romper nada de esto.
 */

type Fila = {
  id: string; userId: string; purpose: string; targetId: string | null;
  codeHash: string; phone: string; channel: string; simulated: boolean;
  attempts: number; expiresAt: Date; consumedAt: Date | null; createdAt: Date;
};

function armar(opts: { live?: boolean; required?: boolean; phone?: string | null; envia?: boolean } = {}) {
  const filas: Fila[] = [];
  const enviados: Array<{ phone: string; texto: string }> = [];
  const usuarios: Record<string, any> = {
    u1: { signaturePhone: opts.phone === undefined ? '573001112233' : opts.phone, signaturePhoneVerifiedAt: null, whatsappPhone: null },
  };
  let n = 0;

  const casa = (w: any, f: Fila) =>
    (w.id === undefined || (typeof w.id === 'string' ? f.id === w.id : f.id !== w.id.not)) &&
    (w.userId === undefined || f.userId === w.userId) &&
    (w.purpose === undefined || f.purpose === w.purpose) &&
    (w.targetId === undefined || f.targetId === w.targetId) &&
    (w.consumedAt === undefined || (w.consumedAt === null ? f.consumedAt === null : true)) &&
    (w.expiresAt?.gt === undefined || f.expiresAt > w.expiresAt.gt) &&
    (w.createdAt?.gte === undefined || f.createdAt >= w.createdAt.gte);

  const prisma: any = {
    appSetting: {
      findMany: jest.fn(async () => [
        { key: 'signature.otpLive', value: String(opts.live ?? false) },
        { key: 'signature.otpRequired', value: String(opts.required ?? true) },
      ]),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => usuarios[where.id] ?? null),
      update: jest.fn(async ({ where, data }: any) => { Object.assign(usuarios[where.id], data); return usuarios[where.id]; }),
    },
    signatureOtp: {
      create: jest.fn(async ({ data }: any) => {
        const f: Fila = { id: `otp-${++n}`, channel: 'whatsapp', attempts: 0, consumedAt: null, createdAt: new Date(), ...data };
        filas.push(f);
        return f;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        [...filas].filter((f) => casa(where, f)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
      findMany: jest.fn(async () => filas),
      count: jest.fn(async ({ where }: any) => filas.filter((f) => casa(where, f)).length),
      update: jest.fn(async ({ where, data }: any) => {
        const f = filas.find((x) => x.id === where.id)!;
        if (data.attempts?.increment) f.attempts += data.attempts.increment;
        if (data.expiresAt) f.expiresAt = data.expiresAt;
        if (data.consumedAt) f.consumedAt = data.consumedAt;
        return f;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const afectadas = filas.filter((f) => casa(where, f));
        for (const f of afectadas) {
          if (data.expiresAt) f.expiresAt = data.expiresAt;
          if (data.consumedAt) f.consumedAt = data.consumedAt;
        }
        return { count: afectadas.length };
      }),
    },
  };

  const whatsapp: any = {
    enabled: true,
    sendText: jest.fn(async (phone: string, texto: string) => {
      if (opts.envia === false) return false;
      enviados.push({ phone, texto });
      return true;
    }),
    sendTemplate: jest.fn(async () => ({ ok: false, error: 'plantilla no aprobada' })),
  };

  return { svc: new SignatureOtpService(prisma, whatsapp), filas, enviados, usuarios, whatsapp };
}

/** El código real que se mandó (lo lee del texto del WhatsApp, como haría el usuario). */
const codigoDe = (texto: string) => texto.match(/(\d{6})/)![1];

describe('SignatureOtpService', () => {
  it('manda el código por WhatsApp y NO lo guarda en claro', async () => {
    const { svc, filas, enviados } = armar({ live: true });
    const r = await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'la orden #1' });

    expect(enviados).toHaveLength(1);
    expect(r.phoneMask).toBe('••• ••• 2233'); // enmascarado hacia afuera
    const codigo = codigoDe(enviados[0].texto);
    // Ni el código ni nada parecido está en la fila: solo un hash scrypt salado.
    expect(filas[0].codeHash).not.toContain(codigo);
    expect(verifyPassword(codigo, filas[0].codeHash)).toBe(true);
  });

  it('en simulación no envía nada y devuelve el código para poder probar', async () => {
    const { svc, enviados } = armar({ live: false });
    const r: any = await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'la orden #1' });
    expect(enviados).toHaveLength(0);
    expect(r.simulated).toBe(true);
    expect(r.codigoSimulado).toMatch(/^\d{6}$/);
  });

  it('sin teléfono no se puede pedir: dice dónde configurarlo', async () => {
    const { svc } = armar({ live: true, phone: null });
    await expect(svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' }))
      .rejects.toThrow(/Mi perfil/);
  });

  it('si el envío falla, el código muere (no se queda uno vivo que nadie recibió)', async () => {
    const { svc, filas } = armar({ live: true, envia: false });
    await expect(svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' }))
      .rejects.toThrow(/No se pudo enviar/);
    expect(filas[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('firma con el código correcto y solo UNA vez', async () => {
    const { svc, enviados } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    const codigo = codigoDe(enviados[0].texto);

    const firma = await svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: codigo });
    expect(firma.simulated).toBe(false);

    await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: codigo }))
      .rejects.toThrow(/No hay ningún código pendiente/);
  });

  it('el código de una orden no firma otra ni lo usa otra persona', async () => {
    const { svc, enviados } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    const codigo = codigoDe(enviados[0].texto);

    await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-2', code: codigo }))
      .rejects.toThrow(/No hay ningún código pendiente/);
    await expect(svc.firmar({ userId: 'u2', purpose: 'purchase.approve', targetId: 'ord-1', code: codigo }))
      .rejects.toThrow(/No hay ningún código pendiente/);
    // Y el bueno sigue sirviendo: los intentos ajenos no lo quemaron.
    await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: codigo }))
      .resolves.toMatchObject({ simulated: false });
  });

  it('se agota a los 5 intentos fallidos: no se puede tantear', async () => {
    const { svc, enviados } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    const bueno = codigoDe(enviados[0].texto);
    const malo = bueno === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: malo })).rejects.toThrow();
    }
    // Ni con el bueno: el código ya está quemado y hay que pedir otro.
    await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: bueno }))
      .rejects.toThrow(/Se agotaron los intentos/);
  });

  it('un código vencido no firma', async () => {
    const { svc, enviados, filas } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    const codigo = codigoDe(enviados[0].texto);
    filas[0].expiresAt = new Date(Date.now() - 1000);
    await expect(svc.firmar({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', code: codigo }))
      .rejects.toThrow(/venció/);
  });

  it('pedir dos veces seguidas no manda dos WhatsApps (freno de reenvío)', async () => {
    const { svc, enviados } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    await expect(svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' }))
      .rejects.toThrow(/Revisa tu WhatsApp/);
    expect(enviados).toHaveLength(1);
  });

  it('cambiar el teléfono quita el sello de verificado y quema los códigos vivos', async () => {
    const { svc, filas, usuarios } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'purchase.approve', targetId: 'ord-1', detalle: 'x' });
    usuarios.u1.signaturePhoneVerifiedAt = new Date();

    await svc.setTelefono('u1', '3009998877');

    expect(usuarios.u1.signaturePhone).toBe('573009998877'); // normalizado a E.164
    expect(usuarios.u1.signaturePhoneVerifiedAt).toBeNull();
    expect(filas[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('la prueba del perfil deja el número verificado', async () => {
    const { svc, enviados, usuarios } = armar({ live: true });
    await svc.pedir({ userId: 'u1', purpose: 'profile.verify', detalle: 'la prueba' });
    await svc.firmar({ userId: 'u1', purpose: 'profile.verify', code: codigoDe(enviados[0].texto) });
    expect(usuarios.u1.signaturePhoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('un teléfono inválido no se guarda', async () => {
    const { svc } = armar();
    await expect(svc.setTelefono('u1', '123')).rejects.toThrow(/no parece válido/);
  });
});
