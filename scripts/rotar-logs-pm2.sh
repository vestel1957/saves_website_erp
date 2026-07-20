#!/usr/bin/env bash
#
# Rotación de los logs de pm2 de SAVES.
#
# pm2-logrotate no se pudo instalar en esta máquina (npm falla al escribir), así que
# se hace a mano: los logs de pm2 son append-only y crecían sin tope (38 MB al
# escribir esto, con un solo fichero de 10 MB). En un disco al 67 % eso acaba
# llenándose, y cuando se llena el disco no arranca nada.
#
# Rota por TAMAÑO y conserva unas pocas generaciones comprimidas. Se usa
# `copytruncate` (copiar y vaciar en sitio) en vez de mover el fichero: pm2 mantiene
# el descriptor abierto, así que si se mueve deja de escribir hasta reiniciarlo.
#
# Cron sugerido (ya instalado):  0 5 * * * /home/dev/saves/scripts/rotar-logs-pm2.sh

set -uo pipefail

DIR="${DIR_LOGS:-$HOME/.pm2/logs}"
MAX_BYTES="${MAX_BYTES:-10485760}"   # 10 MB
GENERACIONES="${GENERACIONES:-5}"

[[ -d "$DIR" ]] || { echo "No existe $DIR"; exit 0; }

for f in "$DIR"/saves-*.log; do
  [[ -f "$f" ]] || continue
  tam="$(stat -c%s "$f" 2>/dev/null || echo 0)"
  [[ "$tam" -lt "$MAX_BYTES" ]] && continue

  # Desplaza las generaciones: .4.gz -> .5.gz, .3.gz -> .4.gz, ...
  for ((i=GENERACIONES-1; i>=1; i--)); do
    [[ -f "$f.$i.gz" ]] && mv -f "$f.$i.gz" "$f.$((i+1)).gz"
  done

  cp "$f" "$f.1" && : > "$f"   # copytruncate: pm2 sigue escribiendo en el mismo inodo
  gzip -f "$f.1"
  echo "[$(date '+%F %T')] rotado $(basename "$f") ($((tam/1024/1024)) MB)"

  # Descarta lo que exceda las generaciones configuradas.
  rm -f "$f.$((GENERACIONES+1)).gz"
done
