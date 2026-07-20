import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge auth gate. Cryptographically verifies the `nexus_token` cookie (same
 * HMAC-SHA256 scheme the NestJS backend signs with) and redirects:
 *   - unauthenticated → /login?next=<path>
 *   - authenticated hitting /login → the `next` param or /
 *
 * This is a UX/routing gate only — the backend guards are the real security
 * boundary and re-verify every API call against fresh DB permissions.
 */

const TOKEN_COOKIE = "nexus_token";
const SECRET = process.env.AUTH_SECRET ?? "nexus-dev-secret-change-me";

// Paths reachable without a staff session (besides Next internals). El portal
// del abonado (`/portal`) usa su propio token en localStorage, no la cookie de
// staff.
const PUBLIC_PATHS = ["/login", "/portal"];

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type TokenClaims = { exp?: number; areas?: string[]; sa?: boolean };

/**
 * Verifica firma + expiración y devuelve el payload decodificado, o null si el
 * token es inválido/expirado.
 */
async function verifyToken(token: string): Promise<TokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const expected = bytesToBase64url(new Uint8Array(sigBuf));
    if (expected !== signature) return null;

    const decoded = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(payload)),
    ) as TokenClaims;
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ── Bloqueo de rutas por área (espejo de las secciones del sidebar) ──
// Cada ruta puede pertenecer a VARIAS áreas: el usuario pasa si tiene alguna.
// La cajera ("caja") comparte rutas con contabilidad/administración/técnicos
// porque su sección propia reutiliza esas pantallas de forma acotada.
const ROUTE_AREA: [RegExp, string[]][] = [
  [/^\/dashboard(\/|$)/, ["gerencia"]],
  [/^\/reportes(\/|$)/, ["gerencia"]],
  [/^\/facturacion(\/|$)/, ["contabilidad", "caja"]],
  [/^\/tesoreria(\/|$)/, ["contabilidad", "caja"]],
  [/^\/cotizaciones(\/|$)/, ["contabilidad"]],
  [/^\/soporte(\/|$)/, ["tecnicos", "caja"]],
  // Transferencias tienen flujo multi-área: técnico solicita, inventario
  // (administración) aprueba/despacha, caja recibe. Regla específica ANTES de /red.
  [/^\/red\/transferencias(\/|$)/, ["tecnicos", "administracion", "caja"]],
  [/^\/red(\/|$)/, ["tecnicos"]],
  // El mapa lo usan tanto el técnico (a dónde voy) como administración y caja
  // (dónde está el cliente). La capa de "dónde está cada técnico" se filtra
  // aparte, dentro de la página y en el backend: no todo el que ve el mapa la ve.
  [/^\/mapa(\/|$)/, ["gerencia", "administracion", "contabilidad", "tecnicos", "sistemas", "caja"]],
  [/^\/mikrotik(\/|$)/, ["tecnicos"]],
  [/^\/configuracion(\/|$)/, ["sistemas"]],
  [/^\/clientes(\/|$)/, ["administracion", "caja"]],
  [/^\/playhub(\/|$)/, ["administracion"]],
  [/^\/inventario(\/|$)/, ["administracion"]],
  [/^\/ordenes(\/|$)/, ["administracion", "caja"]],
  [/^\/proveedores(\/|$)/, ["administracion"]],
  [/^\/devoluciones(\/|$)/, ["administracion"]],
  [/^\/empleados(\/|$)/, ["administracion"]],
  [/^\/proyectos(\/|$)/, ["administracion"]],
  [/^\/agenda(\/|$)/, ["administracion", "caja"]],
];

/** Ruta de aterrizaje de cada área (siempre permitida para quien tiene el área). */
const AREA_LANDING: Record<string, string> = {
  gerencia: "/dashboard",
  contabilidad: "/facturacion",
  caja: "/tesoreria",
  tecnicos: "/soporte",
  sistemas: "/configuracion",
  administracion: "/clientes",
};

function areasForPath(pathname: string): string[] | null {
  for (const [re, areas] of ROUTE_AREA) if (re.test(pathname)) return areas;
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(TOKEN_COOKIE)?.value;
  const claims = token ? await verifyToken(token) : null;
  const valid = claims !== null;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  // Authenticated staff user on the login page → send them into the app.
  // OJO: solo /login. La otra ruta pública (/portal) usa su propio token y debe
  // ser accesible aunque exista una cookie de staff.
  if (valid && pathname === "/login") {
    const next = req.nextUrl.searchParams.get("next") || "/";
    return NextResponse.redirect(new URL(next, req.url));
  }

  // Unauthenticated user on a protected page → send them to login.
  if (!valid && !isPublic) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname + search);
    const res = NextResponse.redirect(url);
    if (token) res.cookies.delete(TOKEN_COOKIE); // clear stale/expired token
    return res;
  }

  // Bloqueo por área: usuario autenticado que NO es superadmin y no pertenece
  // al área dueña de la ruta → se le redirige a la landing de SU área.
  // `areas === undefined` ⇒ token viejo sin el claim: no se aplica (fail-open)
  // para no dejar encerrada una sesión abierta antes de este despliegue.
  if (valid && claims && Array.isArray(claims.areas) && !claims.sa) {
    const areas = areasForPath(pathname);
    if (areas && !areas.some((a) => claims.areas!.includes(a))) {
      const mine = claims.areas[0];
      const dest = (mine && AREA_LANDING[mine]) || "/";
      return NextResponse.redirect(new URL(dest === pathname ? "/" : dest, req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
