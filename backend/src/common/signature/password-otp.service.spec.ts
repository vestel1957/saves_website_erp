import { SignatureOtpService } from './signature-otp.service';
import { PasswordOtpService } from './password-otp.service';

/**
 * Lo que se fija aquí es la regla que da sentido a la función: **el código de un
 * cambio de contraseña sale al WhatsApp del DUEÑO de la cuenta**, aunque quien
 * esté pulsando el botón sea el superusuario. Si algún día alguien "arregla" esto
 * mandándoselo a quien administra, restablecer una clave vuelve a ser apoderarse
 * de una cuenta ajena sin que su dueño se entere — que es justo el agujero que se
 * tapó.
 *
 * Se prueba contra el `SignatureOtpService` de verdad (no un doble): la mitad del
 * valor está en que los dos encajen — el propósito, el teléfono y el consumo del
 * código.
 */

type Fila = {
  id: string; userId: string; purpose: string; targetId: string | null;
  codeHash: string; phone: string; channel: string; simulated: boolean;
  attempts: number; expiresAt: Date; consumedAt: Date | null; createdAt: Date;
};

/** DUENO tiene WhatsApp vinculado; ADMIN también, para poder distinguir a cuál sale. */
const DUENO = { id: 'u-dueno', name: 'Ana Técnica', email: 'ana@vestel.com.co' };
const ADMIN = { id: 'u-admin', name: 'Sistemas' };

function armar(opts: { live?: boolean; passwordRequired?: boolean; phoneDueno?: string | null } = {}) {
  const filas: Fila[] = [];
  const enviados: Array<{ phone: string; texto: string }> = [];
  const usuarios: Record<string, any> = {
    [DUENO.id]: {
      id: DUENO.id, name: DUENO.name, email: DUENO.email,
      signaturePhone: opts.phoneDueno === undefined ? '573001112233' : opts.phoneDueno,
      signaturePhoneVerifiedAt: null, whatsappPhone: null,
    },
    [ADMIN.id]: { id: ADMIN.id, name: ADMIN.name, signaturePhone: '573009998877', signaturePhoneVerifiedAt: null, whatsappPhone: null },
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
        { key: 'signature.otpLive', value: String(opts.live ?? true) },
        { key: 'security.passwordOtpRequired', value: String(opts.passwordRequired ?? true) },
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
    sendText: jest.fn(async (phone: string, texto: string) => { enviados.push({ phone, texto }); return true; }),
    sendTemplate: jest.fn(async () => ({ ok: false, error: 'plantilla no aprobada' })),
  };

  const firma = new SignatureOtpService(prisma, whatsapp);
  return { svc: new PasswordOtpService(firma), filas, enviados, whatsapp };
}

/** El código real que salió (leído del WhatsApp, como lo leería su dueño). */
const codigoDe = (texto: string) => texto.match(/(\d{6})/)![1];

describe('PasswordOtpService', () => {
  it('el código de un restablecimiento sale al WhatsApp del DUEÑO, no al del administrador', async () => {
    const { svc, enviados, filas } = armar();
    await svc.pedir(DUENO, 'reset', ADMIN.name);

    expect(enviados).toHaveLength(1);
    expect(enviados[0].phone).toBe('573001112233'); // el de Ana, no el de Sistemas
    expect(filas[0].userId).toBe(DUENO.id);
    // Y el mensaje le dice quién está detrás, para que pueda frenarlo si no lo pidió.
    expect(enviados[0].texto).toContain('contraseña');
    expect(enviados[0].texto).toContain(ADMIN.name);
  });

  it('el envío va marcado como secreto: el código no puede quedar en el hilo de la bandeja', async () => {
    const { svc, whatsapp } = armar();
    await svc.pedir(DUENO, 'reset', ADMIN.name);
    // Sin esto, `WhatsappLogService` guarda el mensaje literal en `WhatsappMessage`
    // y cualquiera con permiso de bandeja lee el código de un compañero.
    expect(whatsapp.sendText).toHaveBeenCalledWith(expect.any(String), expect.any(String), { secreto: true });
  });

  it('sin código no se cambia la contraseña, y el error dice a quién le llega', async () => {
    const { svc } = armar();
    await expect(svc.exigir(DUENO, 'reset')).rejects.toThrow(/Ana Técnica/);
  });

  it('con el código correcto pasa, y solo una vez', async () => {
    const { svc, enviados } = armar();
    await svc.pedir(DUENO, 'reset', ADMIN.name);
    const codigo = codigoDe(enviados[0].texto);

    await expect(svc.exigir(DUENO, 'reset', codigo)).resolves.toContain('WhatsApp del titular');
    await expect(svc.exigir(DUENO, 'reset', codigo)).rejects.toThrow(/código pendiente|ya se usó/);
  });

  it('el código de un cambio propio NO sirve para un restablecimiento (ni al revés)', async () => {
    const { svc, enviados } = armar();
    await svc.pedir(DUENO, 'propia');
    const codigo = codigoDe(enviados[0].texto);
    await expect(svc.exigir(DUENO, 'reset', codigo)).rejects.toThrow(/código pendiente/);
  });

  it('con la exigencia apagada no pide nada (válvula de escape)', async () => {
    const { svc } = armar({ passwordRequired: false });
    await expect(svc.exigir(DUENO, 'reset')).resolves.toBeNull();
    await expect(svc.pedir(DUENO, 'reset', ADMIN.name)).rejects.toThrow(/no están pidiendo código/);
  });

  it('dueño sin WhatsApp: no se puede, y la política explica la salida', async () => {
    const { svc } = armar({ phoneDueno: null });
    const policy = await svc.policy(DUENO, 'reset');
    expect(policy.required).toBe(true);
    expect(policy.phoneMask).toBeNull();
    expect(policy.blocked).toMatch(/Mi perfil → Seguridad/);
    // Y no se puede colar el cambio sin código aprovechando que no hay teléfono.
    await expect(svc.exigir(DUENO, 'reset')).rejects.toThrow(/no tiene ningún WhatsApp vinculado/);
  });

  it('en simulación no sale ningún WhatsApp y el código se devuelve para poder probar', async () => {
    const { svc, enviados } = armar({ live: false });
    const r: any = await svc.pedir(DUENO, 'propia');
    expect(enviados).toHaveLength(0);
    expect(r.simulated).toBe(true);
    expect(r.codigoSimulado).toMatch(/^\d{6}$/);
    await expect(svc.exigir(DUENO, 'propia', r.codigoSimulado)).resolves.toContain('SIMULACIÓN');
  });
});
