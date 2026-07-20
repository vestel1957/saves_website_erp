#!/usr/bin/env bash
#
# Prueba de RESTAURACIÓN del backup más reciente.
#
# Un backup que nadie ha restaurado nunca no es un backup: es un fichero grande que
# da tranquilidad. Esto lo restaura sobre una base desechable y comprueba que la
# copia sirve REALMENTE para levantar el sistema:
#   - que pg_restore termina sin errores fatales,
#   - que están las tablas, los datos y las CLAVES FORÁNEAS,
#   - que están las SECUENCIAS y que apuntan por encima del máximo real. Esto último
#     es lo que hace la diferencia: un dump anterior a la migración de secuencias
#     restaura "bien" y luego el alta de facturas revienta al primer nextval.
#
# No toca la base de producción: crea y borra la suya.
#
# Uso:  ./scripts/backup-db.sh && ./scripts/verify-restore.sh

set -uo pipefail
cd "$(dirname "$0")/.."

BD_PRUEBA="${BD_PRUEBA:-saves_restore_test}"
DUMP="$(ls -t backups/nexus_*.dump 2>/dev/null | head -1)"

if [[ -z "$DUMP" ]]; then echo "✗ No hay ningún dump en backups/"; exit 1; fi

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')"
CONN="${DATABASE_URL%%\?*}"
USUARIO="$(sed -E 's|.*://([^:]+):.*|\1|' <<<"$CONN")"
export PGPASSWORD="$(sed -E 's|.*://[^:]+:([^@]+)@.*|\1|' <<<"$CONN")"
HOST="$(sed -E 's|.*@([^:/]+).*|\1|' <<<"$CONN")"
BD_REAL="$(basename "$CONN")"

if [[ "$BD_PRUEBA" == "$BD_REAL" ]]; then
  echo "✗ BD_PRUEBA coincide con la base real ($BD_REAL). Abortado."; exit 1
fi

echo "Dump:  $DUMP  ($(du -h "$DUMP" | cut -f1), $(date -r "$DUMP" '+%F %T'))"
echo "Base de prueba: $BD_PRUEBA"

psql -h "$HOST" -U "$USUARIO" -d postgres -c "DROP DATABASE IF EXISTS \"$BD_PRUEBA\"" >/dev/null 2>&1
createdb -h "$HOST" -U "$USUARIO" "$BD_PRUEBA" || { echo "✗ No se pudo crear la base de prueba"; exit 1; }
limpiar() { psql -h "$HOST" -U "$USUARIO" -d postgres -c "DROP DATABASE IF EXISTS \"$BD_PRUEBA\"" >/dev/null 2>&1; }
trap limpiar EXIT

echo -n "Restaurando… "
ERRORES="$(pg_restore -h "$HOST" -U "$USUARIO" -d "$BD_PRUEBA" --no-owner --no-privileges -j 4 "$DUMP" 2>&1 | grep -c "^pg_restore: error" || true)"
echo "hecho (${ERRORES} errores)"

q() { psql -h "$HOST" -U "$USUARIO" -d "$BD_PRUEBA" -tAc "$1"; }

TABLAS="$(q "select count(*) from pg_tables where schemaname='public'")"
FKS="$(q "select count(*) from pg_constraint where contype='f'")"
SECUENCIAS="$(q "select count(*) from pg_class where relkind='S'")"
ABONADOS="$(q "select count(*) from \"Subscriber\"")"
FACTURAS="$(q "select count(*) from \"SubInvoice\"")"
MIGRACIONES="$(q "select count(*) from _prisma_migrations where finished_at is not null" 2>/dev/null || echo 0)"

# La comprobación que de verdad importa: ¿podría el sistema emitir una factura?
DESFASE="$(q "select coalesce((select last_value from \"SubInvoice_tid_seq\"),-1) - coalesce((select max(tid) from \"SubInvoice\"),0)" 2>/dev/null || echo "-999")"

echo
echo "  tablas ............ $TABLAS"
echo "  claves foráneas ... $FKS"
echo "  secuencias ........ $SECUENCIAS"
echo "  migraciones ....... $MIGRACIONES"
echo "  abonados .......... $ABONADOS"
echo "  facturas .......... $FACTURAS"
echo "  secuencia de factura vs máximo real: $DESFASE (debe ser >= 0)"
echo

FALLOS=0
[[ "$ERRORES" -gt 0 ]]        && { echo "✗ pg_restore reportó errores"; FALLOS=1; }
[[ "$TABLAS" -lt 150 ]]       && { echo "✗ faltan tablas"; FALLOS=1; }
[[ "$FKS" -lt 100 ]]          && { echo "✗ faltan claves foráneas"; FALLOS=1; }
[[ "$ABONADOS" -lt 1 ]]       && { echo "✗ no hay datos"; FALLOS=1; }
[[ "$DESFASE" -lt 0 ]]        && { echo "✗ la secuencia de facturas está por detrás del máximo: el alta de facturas fallaría con P2002"; FALLOS=1; }

if [[ "$FALLOS" -eq 0 ]]; then
  echo "✅ RESTAURACIÓN VÁLIDA: el backup sirve para levantar el sistema."
  exit 0
fi
echo "❌ RESTAURACIÓN NO VÁLIDA — este backup no serviría."
exit 1
