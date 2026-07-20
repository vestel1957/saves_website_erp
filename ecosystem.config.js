/**
 * Configuración pm2 de SAVES.
 *
 * NO contiene secretos: los lee de `backend/.env`, que está fuera de git
 * (.gitignore). Este fichero sí se versiona, así que cualquier valor escrito
 * aquí quedaría publicado en el histórico del repo.
 *
 * pm2 sigue inyectando las variables al proceso igual que antes — no dependemos
 * de que ConfigModule/dotenv se cargue antes que PrismaClient.
 *
 * Uso: pm2 start ecosystem.config.js  (o `pm2 restart <app> --update-env`
 * para recoger cambios del .env sin reiniciar todo).
 */
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, 'backend', '.env');

/** Parser dotenv mínimo: KEY=valor, con o sin comillas, ignorando comentarios. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`ecosystem.config.js: falta ${file} (contiene los secretos y no se versiona).`);
  }
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = readEnvFile(ENV_FILE);

/** Falla al arrancar si falta una variable crítica, en vez de degradar en silencio. */
function required(key) {
  const value = env[key];
  if (!value) throw new Error(`ecosystem.config.js: ${key} no está definida en backend/.env`);
  return value;
}

// Compartido por los dos procesos: el middleware del frontend verifica en el edge
// el mismo token que firma el backend, así que el secreto debe ser idéntico.
// Leerlo de una sola fuente evita que se desincronicen.
const AUTH_SECRET = required('AUTH_SECRET');

module.exports = {
  apps: [
    {
      name: 'saves-backend',
      cwd: '/home/dev/saves/backend',
      script: 'dist/src/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: '3061',
        DATABASE_URL: required('DATABASE_URL'),
        CORS_ORIGIN: required('CORS_ORIGIN'),
        // Activa los cronjobs programados (facturación recurrente + cartera).
        CRONS_ENABLED: env.CRONS_ENABLED ?? 'false',
        // Gestión OLT en LIVE: autenticar/reiniciar/eliminar ONU ejecutan por SSH
        // contra las OLT reales (las lecturas siempre son en vivo).
        OLT_LIVE: env.OLT_LIVE ?? 'false',
        // Mikrotik en LIVE: corte/reconexión/alta PPPoE/cambio de perfil ejecutan
        // de verdad contra los routers de producción (auditado en MikrotikActionLog).
        MIKROTIK_LIVE: env.MIKROTIK_LIVE ?? 'false',
        GENIEACS_LIVE: env.GENIEACS_LIVE ?? 'false',
        // Secreto de firma de los JWT. Debe coincidir con el del frontend.
        AUTH_SECRET,
        // Llave de cifrado en reposo de las credenciales de routers y OLTs.
        // Va SEPARADA de AUTH_SECRET a propósito: secret-box usa AUTH_SECRET como
        // respaldo, así que sin esta variable rotar el secreto de sesión dejaría
        // ilegibles todas las contraseñas de los equipos.
        SECRET_ENC_KEY: required('SECRET_ENC_KEY'),
        // Integraciones. El webhook de WhatsApp rechaza todo si falta el app secret
        // (es el único endpoint sin guard: la firma es su única barrera).
        WHATSAPP_WEBHOOK_APP_SECRET: required('WHATSAPP_WEBHOOK_APP_SECRET'),
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '',
        KAPSO_API_KEY: env.KAPSO_API_KEY ?? '',
        KAPSO_PHONE_NUMBER_ID: env.KAPSO_PHONE_NUMBER_ID ?? '',
        WHATSAPP_ALERT_TO: env.WHATSAPP_ALERT_TO ?? '',
        WA_AGENT_ENABLED: env.WA_AGENT_ENABLED ?? 'false',
        OPENAI_API_KEY: env.OPENAI_API_KEY ?? '',
        WHATSAPP_BOT_MODEL: env.WHATSAPP_BOT_MODEL ?? '',
        WHATSAPP_STT_MODEL: env.WHATSAPP_STT_MODEL ?? '',
      },
    },
    {
      name: 'saves-frontend',
      cwd: '/home/dev/saves/frontend',
      script: 'node_modules/.bin/next',
      args: 'start -p 3060 -H 0.0.0.0',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: '3060',
        AUTH_SECRET,
      },
    },
  ],
};
