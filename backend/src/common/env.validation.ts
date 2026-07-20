import { Logger } from '@nestjs/common';

/**
 * Validación del entorno AL ARRANCAR.
 *
 * El problema que resuelve: hay 33 variables leídas con `process.env` en 20 archivos,
 * muchas capturadas en propiedades de instancia dentro del constructor (o sea,
 * congeladas al arrancar). Faltando una, el sistema no fallaba: degradaba en silencio.
 * Arrancar sin `KAPSO_API_KEY` daba un chatbot que nunca responde; sin
 * `WHATSAPP_WEBHOOK_APP_SECRET`, un webhook que rechaza todo. Ninguno de los dos
 * avisaba en el arranque, y el síntoma aparecía días después.
 *
 * Dos niveles a propósito:
 *  - CRÍTICAS: sin ellas no se arranca. Fallar rápido y ruidoso es mejor que un
 *    sistema a medias que factura mal o no cifra.
 *  - DE INTEGRACIÓN: sólo se exigen si la integración está ENCENDIDA. No tiene
 *    sentido pedir la clave de WhatsApp a quien no usa WhatsApp.
 */

type Aviso = { nivel: 'error' | 'aviso'; texto: string };

/** Sin estas no se arranca en producción. */
const CRITICAS: { clave: string; porque: string; minimo?: number }[] = [
  { clave: 'DATABASE_URL', porque: 'sin base de datos no hay nada que servir' },
  { clave: 'AUTH_SECRET', porque: 'firma los JWT; sin ella los tokens serían forjables', minimo: 16 },
  { clave: 'CORS_ORIGIN', porque: 'sin ella el frontend no puede llamar a la API' },
];

/**
 * Integraciones: `gate` es la variable que las enciende; `requiere` lo que necesitan
 * para funcionar de verdad.
 */
const INTEGRACIONES: { nombre: string; gate: string; requiere: string[] }[] = [
  { nombre: 'WhatsApp (Kapso)', gate: 'WA_AGENT_ENABLED', requiere: ['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID'] },
  { nombre: 'Webhook de WhatsApp', gate: 'WA_AGENT_ENABLED', requiere: ['WHATSAPP_WEBHOOK_APP_SECRET'] },
  { nombre: 'Agente IA / búsqueda', gate: 'AI_SEARCH_ENABLED', requiere: ['OPENAI_API_KEY'] },
];

/** Interruptores peligrosos: no bloquean, pero deben quedar dichos en el log. */
const GATES_PELIGROSOS = ['MIKROTIK_LIVE', 'OLT_LIVE', 'EINVOICE_LIVE', 'GENIEACS_LIVE', 'CRONS_ENABLED'];

const encendido = (v: string | undefined) => v === 'true' || v === '1';

export function validarEntorno(env: NodeJS.ProcessEnv = process.env): Aviso[] {
  const avisos: Aviso[] = [];
  const produccion = env.NODE_ENV === 'production';

  for (const c of CRITICAS) {
    const valor = env[c.clave];
    if (!valor) {
      avisos.push({ nivel: produccion ? 'error' : 'aviso', texto: `${c.clave} no está definida — ${c.porque}.` });
    } else if (c.minimo && valor.length < c.minimo) {
      avisos.push({
        nivel: produccion ? 'error' : 'aviso',
        texto: `${c.clave} es demasiado corta (${valor.length} < ${c.minimo}) — ${c.porque}.`,
      });
    }
  }

  // La llave de cifrado en reposo cae en AUTH_SECRET si no está, lo cual funciona
  // pero ata las credenciales de los equipos al secreto de sesión: rotarlo las
  // dejaría ilegibles. Se avisa siempre, sin bloquear.
  if (!env.SECRET_ENC_KEY) {
    avisos.push({
      nivel: 'aviso',
      texto:
        'SECRET_ENC_KEY no está definida: las credenciales de routers/OLT se cifran con AUTH_SECRET, ' +
        'así que rotar el secreto de sesión las dejaría ilegibles.',
    });
  }

  for (const i of INTEGRACIONES) {
    if (!encendido(env[i.gate])) continue;
    const faltan = i.requiere.filter((k) => !env[k]);
    if (faltan.length) {
      avisos.push({
        nivel: 'aviso',
        texto: `${i.nombre} está encendida (${i.gate}) pero falta: ${faltan.join(', ')}. Funcionará a medias.`,
      });
    }
  }

  return avisos;
}

/**
 * Comprueba el entorno y lo deja escrito en el log. En producción, un fallo crítico
 * aborta el arranque: es preferible a un proceso que parece vivo y no lo está.
 */
export function comprobarEntornoOAbortar(env: NodeJS.ProcessEnv = process.env): void {
  const log = new Logger('Entorno');
  const avisos = validarEntorno(env);

  const activos = GATES_PELIGROSOS.filter((g) => encendido(env[g]));
  log.log(
    activos.length
      ? `Interruptores EN VIVO: ${activos.join(', ')} — estas acciones se ejecutan de verdad.`
      : 'Todos los interruptores peligrosos están en simulación (dry-run).',
  );

  for (const a of avisos) {
    if (a.nivel === 'error') log.error(a.texto);
    else log.warn(a.texto);
  }

  const errores = avisos.filter((a) => a.nivel === 'error');
  if (errores.length) {
    throw new Error(
      `No se puede arrancar: ${errores.length} problema(s) de configuración.\n` +
        errores.map((e) => `  - ${e.texto}`).join('\n'),
    );
  }
}
