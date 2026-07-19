#!/usr/bin/env bash
#
# Backup de la base de datos PostgreSQL de SAVES.
# - Formato custom comprimido (pg_dump -Fc) → restaurable con pg_restore.
# - Rota backups más viejos que RETENTION_DAYS.
#
# Uso:          ./scripts/backup-db.sh
# Cron (3:30am, instalado): 30 3 * * * cd /home/dev/saves/backend && ./scripts/backup-db.sh >> backups/backup.log 2>&1
#   (3:00 lo ocupa el backup de otro proyecto en este mismo servidor)
#
# Variables (opcionales):
#   BACKUP_DIR       carpeta destino (default: ./backups)
#   RETENTION_DAYS   días a conservar (default: 14)

set -euo pipefail

cd "$(dirname "$0")/.."

# --- leer DATABASE_URL del .env y quitar el query (?schema=…) que pg_dump no acepta ---
if [[ ! -f .env ]]; then echo "✗ No se encontró .env"; exit 1; fi
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
if [[ -z "${DATABASE_URL:-}" ]]; then echo "✗ DATABASE_URL no definida en .env"; exit 1; fi
CONN="${DATABASE_URL%%\?*}"   # corta desde el primer '?'

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/nexus_$STAMP.dump"

echo "[$(date '+%F %T')] Respaldando → $OUT"
pg_dump -Fc --no-owner --no-privileges -f "$OUT" "$CONN"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date '+%F %T')] ✓ Backup OK ($SIZE)"

# --- rotación ---
DELETED="$(find "$BACKUP_DIR" -name 'nexus_*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
echo "[$(date '+%F %T')] Rotación: $DELETED backup(s) > $RETENTION_DAYS días eliminados."
