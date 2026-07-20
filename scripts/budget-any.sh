#!/usr/bin/env bash
#
# Presupuesto de `any` — impide que la deuda de tipado CREZCA.
#
# Poner `no-explicit-any` en 'error' de golpe rompería el build con 494 avisos, así
# que en vez de eso se fija un techo: si el número sube, esto falla. Cada vez que se
# baje de verdad, se baja también el techo (una línea en este fichero), y el nuevo
# número queda protegido.
#
# Es lo que faltaba: con la regla en 'warn' y sin techo, los 600 `any` llevaban
# meses sin moverse porque nada obligaba a mirarlos.
#
# Uso:  ./scripts/budget-any.sh          (lo llama scripts/verify.sh)

set -uo pipefail
cd "$(dirname "$0")/../frontend"

# Techo actual. BAJARLO al reducir; nunca subirlo sin una razón escrita.
TECHO="${TECHO_ANY:-494}"

ACTUAL="$(npx eslint "src/**/*.{ts,tsx}" -f json 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(sum(1 for f in d for m in f['messages'] if m.get('ruleId')=='@typescript-eslint/no-explicit-any'))
")"

if [[ -z "$ACTUAL" ]]; then echo "✗ No se pudo contar (¿falló eslint?)"; exit 1; fi

if [[ "$ACTUAL" -gt "$TECHO" ]]; then
  printf '\033[31m✗ any: %s (techo %s) — han subido %s\033[0m\n' "$ACTUAL" "$TECHO" "$((ACTUAL - TECHO))"
  echo "  Tipa lo que añadiste, o justifica el cambio y sube el techo a conciencia."
  exit 1
fi

if [[ "$ACTUAL" -lt "$TECHO" ]]; then
  printf '\033[32m✓ any: %s (techo %s) — bajaron %s. Baja el techo en scripts/budget-any.sh\033[0m\n' \
    "$ACTUAL" "$TECHO" "$((TECHO - ACTUAL))"
  exit 0
fi

printf '\033[32m✓ any: %s (en el techo)\033[0m\n' "$ACTUAL"
