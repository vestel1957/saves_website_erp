module.exports = {
  apps: [
    {
      name: "saves-backend",
      cwd: "/home/dev/saves/backend",
      script: "dist/src/main.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "3061",
        DATABASE_URL:
          "postgresql://saves_vestel:49dee02d10287143bf45c7e6702962f7@localhost:5432/saves_vestel?schema=public",
        CORS_ORIGIN: "http://89.117.146.226:3060,http://localhost:3060",
        // Activa los cronjobs programados (facturación recurrente + cartera).
        CRONS_ENABLED: "true",
        // Gestión OLT en LIVE: autenticar/reiniciar/eliminar ONU ejecutan por SSH
        // contra las OLT reales (las lecturas siempre son en vivo).
        OLT_LIVE: "true",
        // Mikrotik en LIVE: corte/reconexión/alta PPPoE/cambio de perfil ejecutan
        // de verdad contra los routers de producción (auditado en MikrotikActionLog).
        MIKROTIK_LIVE: "true",
        // Secreto de firma de los JWT. Debe coincidir con el del frontend.
        AUTH_SECRET:
          "bc7641dd0ecd7e156350b02820fbcfe53cdc4ed199b0f20bae828fef52dcc2ee",
      },
    },
    {
      name: "saves-frontend",
      cwd: "/home/dev/saves/frontend",
      script: "node_modules/.bin/next",
      args: "start -p 3060 -H 0.0.0.0",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "3060",
        AUTH_SECRET:
          "bc7641dd0ecd7e156350b02820fbcfe53cdc4ed199b0f20bae828fef52dcc2ee",
      },
    },
  ],
};
