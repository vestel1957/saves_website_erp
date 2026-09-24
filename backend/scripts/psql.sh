#!/usr/bin/env bash
#
# Abre psql contra la base del ERP (PostgreSQL `saves_vestel`), NO contra el
# MariaDB del legacy. Sin argumentos entra al prompt interactivo; con argumentos
# se los pasa tal cual a psql:
#
#   npm run db                          # prompt interactivo
#   npm run db -- -c '\dt'              # listar tablas y salir
#   npm run db -- -c 'select count(*) from "Subscriber";'
#   npm run db -- -f consulta.sql
#
# La clave sale de backend/.env y nunca se escribe en la línea de comandos, así
# que no queda en el historial de bash ni a la vista en `ps`.
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
[ -f "$ENV_FILE" ] || { echo "psql.sh: falta $ENV_FILE"; exit 1; }

URL="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
[ -n "$URL" ] || { echo "psql.sh: DATABASE_URL no está en $ENV_FILE"; exit 1; }

# Prisma le cuelga ?schema=public&connection_limit=15; psql trata esos parámetros
# como opciones de conexión desconocidas y se niega a abrir.
exec psql "${URL%%\?*}" "$@"
