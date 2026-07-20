import { validarEntorno } from './env.validation';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://x',
  AUTH_SECRET: 'a'.repeat(64),
  CORS_ORIGIN: 'http://localhost:3060',
  SECRET_ENC_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;

const errores = (env: NodeJS.ProcessEnv) => validarEntorno(env).filter((a) => a.nivel === 'error');
const avisos = (env: NodeJS.ProcessEnv) => validarEntorno(env).filter((a) => a.nivel === 'aviso');

describe('validarEntorno', () => {
  it('un entorno completo no reporta nada', () => {
    expect(validarEntorno(base)).toEqual([]);
  });

  it('en producción, una variable crítica ausente es ERROR (aborta el arranque)', () => {
    const e = errores({ ...base, AUTH_SECRET: undefined });
    expect(e).toHaveLength(1);
    expect(e[0].texto).toContain('AUTH_SECRET');
  });

  it('un AUTH_SECRET demasiado corto también es error: firmaría tokens débiles', () => {
    expect(errores({ ...base, AUTH_SECRET: 'corto' })).toHaveLength(1);
  });

  it('fuera de producción los mismos fallos son sólo avisos: no frenan el desarrollo', () => {
    const env = { ...base, NODE_ENV: 'development', AUTH_SECRET: undefined };
    expect(errores(env)).toHaveLength(0);
    expect(avisos(env).some((a) => a.texto.includes('AUTH_SECRET'))).toBe(true);
  });

  it('avisa si SECRET_ENC_KEY falta: ataría las credenciales de equipos al secreto de sesión', () => {
    const a = avisos({ ...base, SECRET_ENC_KEY: undefined });
    expect(a.some((x) => x.texto.includes('SECRET_ENC_KEY'))).toBe(true);
    // Avisa, pero no impide arrancar: con AUTH_SECRET el sistema funciona.
    expect(errores({ ...base, SECRET_ENC_KEY: undefined })).toHaveLength(0);
  });

  it('una integración APAGADA no exige sus credenciales', () => {
    expect(validarEntorno({ ...base, WA_AGENT_ENABLED: 'false' })).toEqual([]);
  });

  it('una integración ENCENDIDA sin credenciales avisa de que irá a medias', () => {
    const a = avisos({ ...base, WA_AGENT_ENABLED: 'true' });
    expect(a.some((x) => x.texto.includes('KAPSO_API_KEY'))).toBe(true);
    // Avisa, no bloquea: el ERP debe seguir funcionando aunque WhatsApp no.
    expect(errores({ ...base, WA_AGENT_ENABLED: 'true' })).toHaveLength(0);
  });

  it('con las credenciales puestas, la integración encendida no molesta', () => {
    const env = { ...base, WA_AGENT_ENABLED: 'true', KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: '1', WHATSAPP_WEBHOOK_APP_SECRET: 's' };
    expect(validarEntorno(env)).toEqual([]);
  });
});
