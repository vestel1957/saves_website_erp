#!/usr/bin/env bash
#
# Panel web de la base de SAVES (pgweb): navegar tablas, consultar SQL y exportar.
#
# Escucha en TODAS las interfaces: se entra por la IP pública del servidor,
#
#   http://89.117.146.226:8093
#
# Queda expuesto a internet y en HTTP plano (pgweb no sirve TLS por sí mismo):
# la clave básica y todo lo consultado viajan sin cifrar, y la sesión tiene
# escritura sobre la base de producción. La clave básica es lo único que separa
# la base de cualquiera que escanee el puerto — no la compartas por chat ni la
# dejes escrita fuera de backend/.env.
#
# La clave de entrada y la de la base salen de backend/.env — este fichero se
# versiona, así que aquí nunca va un secreto escrito.
#
# Arranque permanente:  pm2 start scripts/pgweb.sh --name saves-pgweb
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$RAIZ/backend/.env"

[ -f "$ENV_FILE" ] || { echo "pgweb: falta $ENV_FILE"; exit 1; }

leer() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

DB_URL="$(leer DATABASE_URL)"
[ -n "$DB_URL" ] || { echo "pgweb: DATABASE_URL no está en backend/.env"; exit 1; }

# Prisma le cuelga a la URL ?schema=public&connection_limit=15; pgweb no entiende
# esos parámetros y falla al conectar, así que se recorta la query.
DB_URL="${DB_URL%%\?*}?sslmode=disable"

# Clave del panel. Si PGWEB_AUTH_PASS no está en .env, el panel no arranca: sin
# ella el puerto abierto entrega la base entera a quien lo encuentre.
AUTH_USER="$(leer PGWEB_AUTH_USER)"
AUTH_PASS="$(leer PGWEB_AUTH_PASS)"
[ -n "$AUTH_PASS" ] || { echo "pgweb: falta PGWEB_AUTH_PASS en backend/.env"; exit 1; }

exec /home/dev/.local/bin/pgweb \
  --url "$DB_URL" \
  --bind 0.0.0.0 \
  --listen "${PGWEB_PORT:-8093}" \
  --auth-user "${AUTH_USER:-saves}" \
  --auth-pass "$AUTH_PASS" \
  --lock-session
