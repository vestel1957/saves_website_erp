#!/usr/bin/env bash
#
# Despliegue de SAVES. Existe porque hasta ahora era manual y sólo estaba descrito
# en prosa en el README — y `verify.sh` ya lo daba por existente.
#
# El orden importa, y cada paso está aquí por una razón concreta aprendida:
#
#  1. Verificar ANTES de tocar nada. Si el build falla, mejor enterarse con el
#     sistema aún en pie.
#  2. Migraciones antes del arranque: el código nuevo puede depender de ellas.
#  3. El frontend se compila con el proceso PARADO. Compilar en caliente corrompe
#     `.next` ("client reference manifest") y tumba páginas en producción; es un
#     fallo recurrente y documentado del proyecto.
#  4. Comprobar que el build emitió `.next/BUILD_ID` y `dist/src/main.js` antes de
#     levantar: `next start` entra en bucle de reinicios si `.next` quedó a medias.
#  5. Prueba de humo al final. Un despliegue que no se comprueba no está terminado.
#
# Uso:
#   ./scripts/deploy.sh              # backend + frontend
#   ./scripts/deploy.sh backend      # sólo uno
#   ./scripts/deploy.sh --sin-verify # saltarse la verificación (no recomendado)

set -uo pipefail
cd "$(dirname "$0")/.."
RAIZ="$PWD"

OBJETIVO="todo"
VERIFICAR=1
for arg in "$@"; do
  case "$arg" in
    backend|frontend) OBJETIVO="$arg" ;;
    --sin-verify) VERIFICAR=0 ;;
  esac
done

fallar() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }
paso()   { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# ── 1. Verificación previa ──────────────────────────────────────────────────
if [[ "$VERIFICAR" -eq 1 ]]; then
  paso "Verificación previa"
  "$RAIZ/scripts/verify.sh" "$OBJETIVO" || fallar "La verificación falló: no se despliega."
fi

# ── 2. Backend ──────────────────────────────────────────────────────────────
if [[ "$OBJETIVO" == "todo" || "$OBJETIVO" == "backend" ]]; then
  cd "$RAIZ/backend"

  paso "Migraciones de base de datos"
  npx prisma migrate deploy || fallar "Fallaron las migraciones."
  npx prisma generate >/dev/null 2>&1 || fallar "Falló prisma generate."

  paso "Compilando backend"
  npm run --silent build || fallar "Falló el build del backend."
  [[ -f dist/src/main.js ]] || fallar "El build no emitió dist/src/main.js."

  paso "Reiniciando backend"
  pm2 restart saves-backend --update-env >/dev/null || fallar "pm2 no pudo reiniciar el backend."
fi

# ── 3. Frontend ─────────────────────────────────────────────────────────────
if [[ "$OBJETIVO" == "todo" || "$OBJETIVO" == "frontend" ]]; then
  cd "$RAIZ/frontend"

  paso "Parando el frontend para compilar"
  # Imprescindible: compilar mientras `next start` sirve corrompe .next.
  pm2 stop saves-frontend >/dev/null 2>&1

  paso "Compilando frontend"
  if ! ./node_modules/.bin/next build; then
    pm2 start saves-frontend >/dev/null 2>&1   # dejarlo como estaba
    fallar "Falló el build del frontend (se relanzó el proceso anterior)."
  fi
  [[ -f .next/BUILD_ID && -d .next/static ]] || {
    pm2 start saves-frontend >/dev/null 2>&1
    fallar "El build quedó incompleto (falta BUILD_ID o static)."
  }

  paso "Levantando el frontend"
  pm2 start saves-frontend >/dev/null 2>&1 || pm2 restart saves-frontend >/dev/null
fi

# ── 4. Persistir el estado de pm2 ───────────────────────────────────────────
pm2 save >/dev/null 2>&1

# ── 5. Prueba de humo ───────────────────────────────────────────────────────
paso "Prueba de humo"
sleep 6
FALLOS=0
comprobar() {
  local etq="$1" url="$2" esperado="$3"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$url")"
  if [[ "$code" == "$esperado" ]]; then
    printf '  \033[32m✓\033[0m %-28s %s\n' "$etq" "$code"
  else
    printf '  \033[31m✗\033[0m %-28s %s (esperado %s)\n' "$etq" "$code" "$esperado"
    FALLOS=$((FALLOS+1))
  fi
}
# 401 es la respuesta CORRECTA sin token: significa que la API está viva y protegida.
[[ "$OBJETIVO" != "frontend" ]] && comprobar "API protegida" "http://localhost:3061/api/auth/me" 401
[[ "$OBJETIVO" != "backend"  ]] && comprobar "Frontend /login" "http://localhost:3060/login" 200

printf '\n────────────────────────────\n'
[[ "$FALLOS" -eq 0 ]] && { printf '\033[32mDESPLIEGUE OK\033[0m\n'; exit 0; }
printf '\033[31mDESPLIEGUE CON FALLOS: revisa `pm2 logs`\033[0m\n'
exit 1
