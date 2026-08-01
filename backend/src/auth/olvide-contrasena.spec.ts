import { AuthService } from './auth.service';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { PasswordOtpService } from '../common/signature/password-otp.service';
import { verifyPassword } from './crypto.util';

/**
 * "Olvidé mi contraseña" desde la pantalla de ingreso.
 *
 * Lo que se fija aquí es lo que no se ve al probar la pantalla a mano: que **desde
 * fuera todos los correos se comporten igual**. Es una ruta abierta a cualquiera
 * que llegue a la IP, y un "ese correo no existe" —o un error distinto en el paso
 * del código— le entrega la lista de empleados a quien la esté tanteando. Lo otro
 * que se fija es que el código NUNCA viaje en la respuesta: en simulación se
 * devolvía a quien lo pedía, y aquí eso sería teclear el correo de gerencia y
 * leer su código.
 */

const EMAIL = 'ana@vestel.com.co';

function armar(opts: { live?: boolean; phone?: string | null; activa?: boolean } = {}) {
  const filas: any[] = [];
  const enviados: Array<{ phone: string; texto: string }> = [];
  const usuario: any = {
    id: 'u-ana', name: 'Ana Técnica', email: EMAIL, isActive: opts.activa !== false,
    passwordHash: 'hash-viejo',
    signaturePhone: opts.phone === undefined ? '573001112233' : opts.phone,
    signaturePhoneVerifiedAt: null, whatsappPhone: null,
  };
  let n = 0;

  const casa = (w: any, f: any) =>
    (w.id === undefined || (typeof w.id === 'string' ? f.id === w.id : f.id !== w.id.not)) &&
    (w.userId === undefined || f.userId === w.userId) &&
    (w.purpose === undefined || f.purpose === w.purpose) &&
    (w.targetId === undefined || f.targetId === w.targetId) &&
    (w.consumedAt === undefined || (w.consumedAt === null ? f.consumedAt === null : true)) &&
    (w.expiresAt?.gt === undefined || f.expiresAt > w.expiresAt.gt) &&
    (w.createdAt?.gte === undefined || f.createdAt >= w.createdAt.gte);

  const prisma: any = {
    appSetting: { findMany: jest.fn(async () => [{ key: 'signature.otpLive', value: String(opts.live ?? true) }]) },
    auditLog: { create: jest.fn(async () => ({})) },
    user: {
      findFirst: jest.fn(async ({ where }: any) => {
        const pedido = where.email?.equals?.toLowerCase?.() ?? '';
        const activaOk = where.isActive === undefined || usuario.isActive === where.isActive;
        return pedido === usuario.email.toLowerCase() && activaOk ? usuario : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => (where.id === usuario.id ? usuario : null)),
      update: jest.fn(async ({ where, data }: any) => { if (where.id === usuario.id) Object.assign(usuario, data); return usuario; }),
    },
    signatureOtp: {
      create: jest.fn(async ({ data }: any) => {
        const f = { id: `otp-${++n}`, channel: 'whatsapp', attempts: 0, consumedAt: null, createdAt: new Date(), ...data };
        filas.push(f); return f;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        [...filas].filter((f) => casa(where, f)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
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
    sendTemplate: jest.fn(async () => ({ ok: false, error: 'sin plantilla' })),
  };

  const otp = new PasswordOtpService(new SignatureOtpService(prisma, whatsapp));
  return { svc: new AuthService(prisma, otp), enviados, usuario, filas };
}

const codigoDe = (texto: string) => texto.match(/(\d{6})/)![1];

/**
 * El paso 1 responde SIN esperar al envío (la respuesta es la misma pase lo que
 * pase, así que hacer esperar al usuario no aportaba nada). Por eso las pruebas
 * que necesitan el código tienen que esperar a que el WhatsApp salga de verdad.
 */
async function esperarEnvio(enviados: unknown[], ms = 1000) {
  const hasta = Date.now() + ms;
  while (!enviados.length && Date.now() < hasta) await new Promise((r) => setTimeout(r, 5));
  if (!enviados.length) throw new Error('el código nunca salió');
}

describe('AuthService · olvidé mi contraseña', () => {
  it('un correo que existe y uno que no responden EXACTAMENTE lo mismo', async () => {
    const { svc } = armar();
    const real = await svc.forgotPassword(EMAIL, '1.2.3.4');
    const falso = await svc.forgotPassword('nadie@vestel.com.co', '1.2.3.4');
    expect(falso).toEqual(real);
  });

  it('una cuenta inhabilitada tampoco se distingue de una inexistente', async () => {
    const { svc, enviados } = armar({ activa: false });
    const r = await svc.forgotPassword(EMAIL, '1.2.3.4');
    expect(r.ok).toBe(true);
    expect(enviados).toHaveLength(0); // no sale ningún código
  });

  it('sin WhatsApp vinculado se calla: la respuesta no delata que ese correo sí existe', async () => {
    const conTelefono = armar();
    const sinTelefono = armar({ phone: null });
    const a = await conTelefono.svc.forgotPassword(EMAIL);
    const b = await sinTelefono.svc.forgotPassword(EMAIL);
    expect(b).toEqual(a);
    expect(sinTelefono.enviados).toHaveLength(0);
  });

  it('el código NUNCA viaja en la respuesta, ni siquiera en simulación', async () => {
    const { svc, enviados } = armar({ live: false });
    const r = await svc.forgotPassword(EMAIL);
    expect(enviados).toHaveLength(0); // simulación: no sale WhatsApp
    expect(JSON.stringify(r)).not.toMatch(/\d{6}/);
    expect(Object.keys(r)).toEqual(['ok', 'message']);
  });

  it('el paso del código da el MISMO error si el correo no existe que si el código no es', async () => {
    const { svc, enviados } = armar();
    await svc.forgotPassword(EMAIL);
    await esperarEnvio(enviados);
    const codigo = codigoDe(enviados[0].texto);
    const malo = String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');

    const errores: string[] = [];
    for (const intento of [
      () => svc.forgotCheck('nadie@vestel.com.co', '123456'),
      () => svc.forgotCheck(EMAIL, malo),
    ]) {
      await intento().catch((e) => errores.push(e.message));
    }
    expect(errores).toHaveLength(2);
    expect(errores[0]).toBe(errores[1]);
  });

  it('flujo completo: el paso 2 no gasta el código y el 3 sí (una sola vez)', async () => {
    const { svc, enviados, usuario } = armar();
    await svc.forgotPassword(EMAIL);
    await esperarEnvio(enviados);
    const codigo = codigoDe(enviados[0].texto);

    // El paso 2 se puede repetir: todavía no ha escrito la contraseña nueva.
    await expect(svc.forgotCheck(EMAIL, codigo)).resolves.toEqual({ ok: true });
    await expect(svc.forgotCheck(EMAIL, codigo)).resolves.toEqual({ ok: true });

    await expect(svc.forgotReset(EMAIL, codigo, 'ClaveNueva2026')).resolves.toEqual({ ok: true });
    expect(verifyPassword('ClaveNueva2026', usuario.passwordHash)).toBe(true);

    // Y ese código ya no vuelve a servir.
    await expect(svc.forgotReset(EMAIL, codigo, 'OtraMas2026')).rejects.toThrow(/no es válido o ya venció/);
    expect(verifyPassword('ClaveNueva2026', usuario.passwordHash)).toBe(true);
  });

  it('el WhatsApp avisa de qué se trata y de que lo pidieron desde el ingreso', async () => {
    const { svc, enviados } = armar();
    await svc.forgotPassword(EMAIL);
    await esperarEnvio(enviados);
    expect(enviados[0].phone).toBe('573001112233');
    expect(enviados[0].texto).toMatch(/contraseña/i);
    expect(enviados[0].texto).toMatch(/pantalla de ingreso/i);
  });
});
