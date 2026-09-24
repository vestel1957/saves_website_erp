#!/usr/bin/env bash
# Corre el plan de centros de costo fase por fase con `claude -p`, cada una con contexto limpio.
# Pensado para ir dentro de tmux: sobrevive a que se cierre la terminal o la sesión de Claude.
#   tmux new -d -s saves-centros-costo /home/dev/saves/docs/centros-de-costo/correr.sh
# Para retomar desde una fase: DESDE=3 correr.sh
set -u
DIR=/home/dev/saves/docs/centros-de-costo
LOGS=$DIR/logs
mkdir -p "$LOGS"
DESDE=${DESDE:-0}
HASTA=${HASTA:-7}

log() { echo "[$(TZ=America/Bogota date '+%F %T')] $*" | tee -a "$LOGS/corrida.log"; }

for n in $(seq "$DESDE" "$HASTA"); do
  if grep -q "^FASE $n: OK" "$DIR/BITACORA.md"; then log "fase $n ya estaba OK, sigo"; continue; fi
  log "══ fase $n: arranca"
  cd /home/dev/saves
  claude -p --model opus --permission-mode bypassPermissions \
    "Estás ejecutando de forma autónoma, sin nadie mirando, la FASE $n del plan en docs/centros-de-costo/PLAN.md del proyecto /home/dev/saves (ERP de Vestel en producción). Lee PLAN.md completo y docs/centros-de-costo/BITACORA.md (lo que hicieron las fases anteriores) antes de tocar nada. Haz SOLO la fase $n, respetando las 'Reglas para todas las fases'. Verifica tu trabajo. Al terminar añade tu entrada a BITACORA.md y, sólo si la fase quedó completa y verificada, una línea exacta 'FASE $n: OK'. Si te bloqueas o hace falta una decisión de negocio, escribe 'BLOQUEO fase $n:' con el detalle y termina sin la línea OK." \
    --output-format stream-json --verbose > "$LOGS/fase-$n.jsonl" 2> "$LOGS/fase-$n.err"
  rc=$?
  if grep -q "^FASE $n: OK" "$DIR/BITACORA.md"; then
    log "   ✓ fase $n OK (rc=$rc)"
  else
    log "   ✗ fase $n sin OK (rc=$rc) — me detengo. Ver BITACORA.md y logs/fase-$n.*"
    exit 1
  fi
done
log "══ plan terminado"
