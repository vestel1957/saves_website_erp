#!/usr/bin/env bash
#
# Verificación local completa, para correr ANTES de desplegar.
#
# Existe porque el CI de GitHub Actions nunca se ha ejecutado: el repo no tiene
# remoto. Hasta que lo tenga, esto es la única verificación real del proyecto.
#
# Incluye el BUILD del backend a propósito: `tsc --noEmit` puede dar verde sobre
# errores que `nest build` sí detecta (pasó con un mock tipado como tupla vacía),
# así que un verify sin build da una falsa sensación de seguridad.
#
# NO compila el frontend, y es deliberado: `next build` mientras `next start`
# está sirviendo corrompe `.next` (error de "client reference manifest") y tumba
# páginas en producción. El build del frontend va en el despliegue, con el proceso
# parado — ver scripts/deploy.sh.
#
# Uso:
#   ./scripts/verify.sh            # todo
#   ./scripts/verify.sh backend    # sólo backend
#   ./scripts/verify.sh frontend   # sólo frontend

set -uo pipefail
cd "$(dirname "$0")/.."
RAIZ="$PWD"

OBJETIVO="${1:-todo}"
FALLOS=()

# Cada paso corre en silencio y sólo escupe su salida si falla: con 795 warnings de
# linter (deuda conocida y tolerada a propósito), volcarlo todo enterraría el resumen.
# De los que pasan se muestra sólo el recuento de warnings, que es la métrica que
# interesa vigilar de una corrida a otra.
paso() {
  local nombre="$1"; shift
  local salida
  salida="$(mktemp)"
  printf '  %-42s' "$nombre"
  if "$@" >"$salida" 2>&1; then
    local warns
    warns="$(grep -cE '(^|[[:space:]])warning' "$salida" 2>/dev/null || true)"
    if [[ "${warns:-0}" -gt 0 ]]; then
      printf '\033[32mOK\033[0m \033[33m(%s warnings)\033[0m\n' "$warns"
    else
      printf '\033[32mOK\033[0m\n'
    fi
  else
    printf '\033[31mFALLA\033[0m\n'
    FALLOS+=("$nombre")
    sed 's/^/    │ /' "$salida" | tail -40
  fi
  rm -f "$salida"
}

if [[ "$OBJETIVO" == "todo" || "$OBJETIVO" == "backend" ]]; then
  cd "$RAIZ/backend"
  paso "backend · lint"      npm run --silent lint
  paso "backend · typecheck" npm run --silent typecheck
  paso "backend · test"      npm run --silent test
  paso "backend · build"     npm run --silent build
  # El build puede terminar en éxito sin emitir el entrypoint; pm2 arrancaría en bucle.
  paso "backend · dist/src/main.js emitido" test -f dist/src/main.js
fi

if [[ "$OBJETIVO" == "todo" || "$OBJETIVO" == "frontend" ]]; then
  cd "$RAIZ/frontend"
  paso "frontend · lint"      npm run --silent lint
  paso "frontend · typecheck" npm run --silent typecheck
fi

cd "$RAIZ"
printf '\n────────────────────────────\n'
if [[ ${#FALLOS[@]} -eq 0 ]]; then
  printf '\033[32mVERIFICACIÓN OK\033[0m\n'
  exit 0
fi
printf '\033[31mFALLÓ: %s\033[0m\n' "${FALLOS[*]}"
exit 1
