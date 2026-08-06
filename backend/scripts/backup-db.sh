#!/usr/bin/env bash
#
# Backup de la base de datos PostgreSQL de SAVES.
# - Formato custom comprimido (pg_dump -Fc) → restaurable con pg_restore.
# - Rota backups más viejos que RETENTION_DAYS.
#
# ─── POR QUÉ ESTE SCRIPT ES ASÍ ──────────────────────────────────────────────
# El 2026-08-03 el backup falló y NADIE se enteró:
#
#   [2026-08-03 04:04:48] Respaldando → ./backups/nexus_20260803_040448.dump
#   pg_dump: error: FATAL: remaining connection slots are reserved for
#                          non-replication superuser connections
#
# Postgres está compartido entre 6 aplicaciones con max_connections=100. Esa noche
# no quedaban conexiones libres, `pg_dump` no pudo entrar y `set -e` mató el script
# dejando un fichero de **0 bytes** en la carpeta de backups. A simple vista había
# un backup de esa fecha. No lo había.
#
# De ahí las cuatro defensas de abajo:
#   1. Se limpia el fichero a medias si algo falla (trap): mejor ningún backup que
#      uno falso, porque un fichero vacío da una confianza que no existe.
#   2. Reintentos con espera: el fallo era transitorio (un pico de conexiones),
#      así que volver a intentarlo a los pocos minutos lo resuelve solo.
#   3. Se VERIFICA el dump leyendo su índice con `pg_restore --list`. Que el
#      fichero pese no significa que sirva.
#   4. Se avisa por WhatsApp y se deja un fichero de estado. Un backup que falla
#      en silencio es exactamente igual de útil que no tener backup.
#
# Uso:          ./scripts/backup-db.sh
# Cron (3:30am, instalado): 30 3 * * * cd /home/dev/saves/backend && ./scripts/backup-db.sh >> backups/backup.log 2>&1
#   (3:00 lo ocupa el backup de otro proyecto en este mismo servidor)
#
# Variables (opcionales):
#   BACKUP_DIR       carpeta destino (default: ./backups)
#   RETENTION_DAYS   días a conservar (default: 14)
#   INTENTOS         reintentos ante fallo transitorio (default: 3)
#   ESPERA_S         segundos entre reintentos (default: 300 = 5 min)
#   MIN_BYTES        tamaño mínimo aceptable del dump (default: 10485760 = 10 MB)

set -euo pipefail

cd "$(dirname "$0")/.."

log() { echo "[$(date '+%F %T')] $*"; }

# --- leer DATABASE_URL del .env y quitar el query (?schema=…) que pg_dump no acepta ---
if [[ ! -f .env ]]; then echo "✗ No se encontró .env"; exit 1; fi
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
if [[ -z "${DATABASE_URL:-}" ]]; then echo "✗ DATABASE_URL no definida en .env"; exit 1; fi
CONN="${DATABASE_URL%%\?*}"   # corta desde el primer '?'

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
INTENTOS="${INTENTOS:-3}"
ESPERA_S="${ESPERA_S:-300}"
MIN_BYTES="${MIN_BYTES:-10485760}"
ESTADO="$BACKUP_DIR/estado.txt"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/nexus_$STAMP.dump"

# ---------------------------------------------------------------------------
# Aviso por WhatsApp. Va con `curl` directo contra Kapso y NO a través de la API
# del backend a propósito: si el backup falla suele ser porque la base o el
# servidor están en apuros, que es justo cuando la API puede no responder.
# Nunca rompe el script (`|| true`): un aviso que falla no debe ocultar el error
# real que lo provocó.
# ---------------------------------------------------------------------------
avisar() {
  local mensaje="$1"
  local api_key phone_id destino base version
  api_key="$(grep -E '^KAPSO_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')" || true
  phone_id="$(grep -E '^KAPSO_PHONE_NUMBER_ID=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')" || true
  destino="$(grep -E '^WHATSAPP_ALERT_TO=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')" || true
  [[ -z "${api_key:-}" || -z "${phone_id:-}" || -z "${destino:-}" ]] && return 0
  base="${KAPSO_BASE_URL:-https://api.kapso.ai/meta/whatsapp}"
  version="${KAPSO_GRAPH_VERSION:-v24.0}"
  curl -s -m 20 -o /dev/null -X POST "$base/$version/$phone_id/messages" \
    -H "X-API-Key: $api_key" -H 'Content-Type: application/json' \
    -d "$(printf '{"messaging_product":"whatsapp","to":"%s","type":"text","text":{"body":%s}}' \
          "$destino" "$(printf '%s' "$mensaje" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    || true
}

fallo() {
  local motivo="$1"
  # Un dump a medias es peor que ninguno: parece un backup y no lo es.
  if [[ -f "$OUT" ]]; then
    rm -f "$OUT"
    log "  (fichero incompleto eliminado: $(basename "$OUT"))"
  fi
  log "✗ BACKUP FALLIDO: $motivo"
  printf 'FALLO %s %s\n' "$(date '+%F %T')" "$motivo" > "$ESTADO"
  avisar "🔴 SAVES · el backup de la base de datos FALLÓ

$motivo

Servidor: $(hostname)
Hora: $(date '+%F %T')
Último backup válido: $(ls -t "$BACKUP_DIR"/nexus_*.dump 2>/dev/null | head -1 | xargs -r basename || echo 'NINGUNO')"
  exit 1
}

# Limpieza si el script muere por cualquier motivo no contemplado (kill, disco lleno).
trap '[[ -f "$OUT" ]] && rm -f "$OUT"; true' ERR

# ---------------------------------------------------------------------------
# Volcado, con reintentos ante fallo transitorio
# ---------------------------------------------------------------------------
log "Respaldando → $OUT"
intento=1
while true; do
  # `|| true` para poder inspeccionar el error en vez de morir por `set -e`.
  err="$(pg_dump -Fc --no-owner --no-privileges -f "$OUT" "$CONN" 2>&1)" && break || true

  rm -f "$OUT"
  if (( intento >= INTENTOS )); then
    fallo "pg_dump falló tras $INTENTOS intentos: ${err:-sin detalle}"
  fi
  log "  intento $intento/$INTENTOS falló (${err:-sin detalle}); reintento en ${ESPERA_S}s"
  intento=$(( intento + 1 ))
  sleep "$ESPERA_S"
done

# ---------------------------------------------------------------------------
# Verificación: que exista, que pese y que se pueda LEER
# ---------------------------------------------------------------------------
[[ -f "$OUT" ]] || fallo "pg_dump terminó bien pero no dejó fichero."

BYTES="$(stat -c%s "$OUT")"
if (( BYTES < MIN_BYTES )); then
  fallo "el dump pesa $BYTES bytes (mínimo esperado: $MIN_BYTES). Backup sospechoso."
fi

# `pg_restore --list` lee la cabecera y el índice del dump. Si el fichero está
# truncado o corrupto, falla aquí y no el día que haga falta restaurarlo.
TABLAS="$(pg_restore --list "$OUT" 2>/dev/null | grep -c 'TABLE DATA' || true)"
if (( TABLAS < 50 )); then
  fallo "el dump sólo declara $TABLAS tablas con datos (se esperan >50): está incompleto o corrupto."
fi

SIZE="$(du -h "$OUT" | cut -f1)"
log "✓ Backup OK ($SIZE · $TABLAS tablas con datos · verificado con pg_restore --list)"
printf 'OK %s %s %s\n' "$(date '+%F %T')" "$(basename "$OUT")" "$SIZE" > "$ESTADO"

# ---------------------------------------------------------------------------
# Rotación
# ---------------------------------------------------------------------------
DELETED="$(find "$BACKUP_DIR" -name 'nexus_*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
log "Rotación: $DELETED backup(s) > $RETENTION_DAYS días eliminados."

# Barrido de restos de fallos anteriores (los 0 bytes que dejó la versión vieja).
VACIOS="$(find "$BACKUP_DIR" -name 'nexus_*.dump' -type f -size 0 -print -delete | wc -l)"
(( VACIOS > 0 )) && log "Limpieza: $VACIOS backup(s) de 0 bytes eliminados."

exit 0
