#!/usr/bin/env bash
#
# Restaura un backup de Nexus creado con backup-db.sh.
# ⚠️  DESTRUCTIVO: reemplaza el contenido de la base actual.
#
# Uso:  ./scripts/restore-db.sh backups/nexus_YYYYMMDD_HHMMSS.dump

set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "Uso: $0 <archivo.dump>"
  echo "Backups disponibles:"; ls -1t backups/nexus_*.dump 2>/dev/null | head || echo "  (ninguno)"
  exit 1
fi

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
CONN="${DATABASE_URL%%\?*}"

read -r -p "⚠️  Esto SOBREESCRIBE la base actual con '$FILE'. Escribe RESTAURAR para continuar: " ans
if [[ "$ans" != "RESTAURAR" ]]; then echo "Cancelado."; exit 1; fi

echo "Restaurando…"
pg_restore --clean --if-exists --no-owner --no-privileges -d "$CONN" "$FILE"
echo "✓ Restauración completada."
