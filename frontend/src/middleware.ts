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

type TokenClaims = { exp?: number; areas?: string[]; sa?: boolean; inv?: boolean };

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
  // El dashboard lo ven tres áreas con contenidos distintos: gerencia el panel
  // ejecutivo, caja el panel de su caja (el informe del recaudo del día) y
  // técnicos su jornada (las órdenes que le tocan hoy y su rendimiento).
  [/^\/dashboard(\/|$)/, ["gerencia", "caja", "tecnicos"]],
  [/^\/reportes(\/|$)/, ["gerencia"]],
  [/^\/facturacion(\/|$)/, ["contabilidad", "caja"]],
  // Pagos en línea del portal: es el recaudo de TODAS las sedes y trae el botón de
  // forzar la pasada (que sale a tocar routers y OLTs). Regla específica ANTES de
  // la general de /tesoreria, que sí incluye a la cajera — y la API no la deja
  // pasar, así que sin esto la pantalla se le abriría para morir en un 403.
  [/^\/tesoreria\/pagos-en-linea(\/|$)/, ["contabilidad", "administracion", "gerencia"]],
  [/^\/tesoreria(\/|$)/, ["contabilidad", "caja"]],
  [/^\/cotizaciones(\/|$)/, ["contabilidad"]],
  // El agendamiento lo hace la cajera (y administración), no el técnico: regla
  // específica ANTES de /soporte, que sí es suyo.
  [/^\/mi-agenda(\/|$)/, ["tecnicos"]],
  [/^\/soporte\/agenda(\/|$)/, ["caja", "administracion"]],
  // Administración entra también (2026-09-07): la API ya le abría todas las rutas
  // de tickets y ya tenía el agendamiento, que trabaja sobre estas mismas órdenes
  // — este gate era lo único que la dejaba fuera de la pantalla, y con él una
  // jefatura no podía ni MIRAR el trabajo de los técnicos. Quién ve el enlace lo
  // sigue decidiendo la llave de pantalla (`screen.soporte`), que el área no trae
  // por rol; y quién puede TOCAR la orden, `support.write`.
  [/^\/soporte(\/|$)/, ["tecnicos", "caja", "administracion"]],
  // Transferencias tienen flujo multi-área: técnico solicita, inventario
  // (administración) aprueba/despacha, caja recibe. Regla específica ANTES de /red.
  [/^\/red\/transferencias(\/|$)/, ["tecnicos", "administracion", "caja"]],
  // El inventario de equipos lo administra administración (2026-07-31): el técnico
  // dejó de tener la pantalla, pero el área sigue en la lista porque el jefe de
  // bodega y la cajera entran por aquí a mover equipo.
  [/^\/red\/equipos(\/|$)/, ["tecnicos", "administracion"]],
  // Lo ÚNICO de /red que le queda al técnico: sus equipos. Va ANTES de la regla
  // general, que ya no lo incluye.
  [/^\/red\/bodegas(\/|$)/, ["tecnicos", "administracion"]],
  // Equipos disponibles por sede: administración y la cajera (el backend la acota a
  // sus sedes). El jefe de bodega entra por RUTAS_JEFE_BODEGA.
  [/^\/red\/disponibles(\/|$)/, ["administracion", "caja"]],
  // RED / ISP y MIKROTIK salieron del perfil del técnico (2026-07-31): conexiones,
  // NAPs, OLT, GenieACS y los routers son de administración. El backend lo repite
  // por su cuenta (`network/modulo-red.guard.ts`); esto sólo evita el viaje.
  [/^\/red(\/|$)/, ["administracion"]],
  // El mapa lo usan tanto el técnico (a dónde voy) como administración y caja
  // (dónde está el cliente). La capa de "dónde está cada técnico" se filtra
  // aparte, dentro de la página y en el backend: no todo el que ve el mapa la ve.
  [/^\/mapa(\/|$)/, ["gerencia", "administracion", "contabilidad", "tecnicos", "sistemas", "caja"]],
  [/^\/mikrotik(\/|$)/, ["administracion"]],
  // La bandeja de WhatsApp la atiende quien atiende clientes; configurar el canal
  // sigue siendo de sistemas y vive bajo /configuracion.
  // Los mensajes masivos no son atender clientes: los lanza quien administra el
  // canal (la API pide `system.whatsapp`). Regla específica ANTES de /whatsapp.
  [/^\/whatsapp\/masivo(\/|$)/, ["sistemas"]],
  [/^\/whatsapp(\/|$)/, ["administracion", "caja", "sistemas"]],
  // El puntaje de las órdenes lo fija gerencia (es con qué se mide al técnico),
  // aunque la pantalla viva con el resto de catálogos. Regla específica ANTES de
  // la general de /configuracion, que sigue siendo sólo de sistemas.
  [/^\/configuracion\/puntajes(\/|$)/, ["sistemas", "gerencia"]],
  // Empleados se mudó a CONFIGURACIÓN (2026-08-05) con ruta y todo. Conserva
  // "administracion" además de "sistemas": quien lleva la gente (fichas, cargos,
  // documentos) sigue siendo administración — mudar la pantalla de sección no es
  // quitarle el acceso a quien la usa. Regla específica ANTES de la general.
  [/^\/configuracion\/empleados(\/|$)/, ["sistemas", "administracion"]],
  [/^\/configuracion(\/|$)/, ["sistemas"]],
  // La FICHA del cliente se le abre al TÉCNICO (2026-08-31, a pedido del usuario):
  // llega a ella desde su orden y necesita lo que hay dentro — teléfono, dirección,
  // plan, equipos y el histórico de lo que ya se le hizo —. Es de CONSULTA: los
  // botones que vuelven sobre el cliente (editar, plan, estado, cobrar) no se le
  // pintan, y la API se los niega desde `SubscribersController.soloMira`.
  // El LISTADO sigue sin ser suyo (regla general de abajo): "el técnico ve lo suyo",
  // y los 15.000 clientes de la empresa no lo son. Regla específica ANTES de ella.
  // `grupos` queda fuera a propósito: es otra pantalla, no una ficha.
  [/^\/clientes\/(?!grupos(\/|$))[^/]+/, ["administracion", "caja", "tecnicos"]],
  [/^\/clientes(\/|$)/, ["administracion", "caja"]],
  // PlayHub: la cajera lo trabaja en ventanilla; el reporte le sale acotado a su sede.
  [/^\/playhub(\/|$)/, ["administracion", "caja"]],
  // Traspasos de material: la cajera le entrega material al técnico (traspaso a su
  // almacén) y —desde 2026-09-03— el TÉCNICO devuelve a la bodega de su sede lo que
  // le sobró. Cada uno ve un formulario distinto: el backend
  // (`InventoryService.transferContext`) decide el modo, aquí sólo se abre la puerta.
  // Regla específica ANTES de /inventario, que sigue siendo de administración.
  [/^\/inventario\/traspasos(\/|$)/, ["administracion", "caja", "tecnicos"]],
  // Bodegas de material: al técnico se le abre SU bodega (el backend sólo le
  // devuelve esa). Regla específica ANTES de /inventario, que sigue siendo de
  // administración — del módulo no se le abre nada más.
  [/^\/inventario\/bodegas(\/|$)/, ["administracion", "tecnicos"]],
  // Actas de traspaso: es la pantalla donde se FIRMA el recibido, así que la tiene
  // que abrir quien recibe — el técnico en su almacén — además de quien entrega (la
  // cajera) y de administración. La API ya las aceptaba a las tres
  // (`InventoryController.TRASPASOS`); era este gate el que dejaba al técnico con el
  // material en tránsito y sin forma de acreditarlo. Regla específica ANTES de la
  // general de /inventario.
  [/^\/inventario\/actas(\/|$)/, ["administracion", "tecnicos", "caja"]],
  [/^\/inventario(\/|$)/, ["administracion"]],
  // Compras salió del perfil de caja (2026-07-29): quien recauda no ordena compras.
  // Matiz de 2026-09-08 (a pedido del usuario): la cajera entra a MIRAR la orden y a
  // subirle el papel —la factura del proveedor, el comprobante del pago—, que es lo
  // que tiene en la mano en ventanilla. Ordenar la compra sigue sin ser suyo: crear
  // (/nueva) y los catálogos (categorías) quedan fuera con reglas específicas ANTES de
  // la general, y la API le niega todo lo que no sea leer o adjuntar.
  [/^\/ordenes\/nueva(\/|$)/, ["administracion"]],
  [/^\/ordenes\/categorias(\/|$)/, ["administracion"]],
  [/^\/ordenes(\/|$)/, ["administracion", "caja"]],
  [/^\/proveedores(\/|$)/, ["administracion"]],
  [/^\/devoluciones(\/|$)/, ["administracion"]],
  // El archivo de documentos bajó a PERSONAS / PROYECTOS (2026-08-05): dejó de ser
  // /configuracion/documentos y por eso ya no hereda el gate de sistemas. Se le
  // conserva el área además de dársela a administración, dueña de la sección.
  // OJO: no confundir con /documentacion (los manuales), que no lleva gate.
  [/^\/documentos(\/|$)/, ["administracion", "sistemas"]],
  [/^\/proyectos(\/|$)/, ["administracion"]],
  // El Panel de Tareas salió del perfil del TÉCNICO (2026-09-10, a pedido del
  // usuario: «sus actividades se gestionan mediante el agendamiento diario»). Le
  // queda a administración, gerencia y caja; la API repite lo mismo por su cuenta
  // (`tasks.router.ts`) y el permiso `screen.tareas` se le retiró al rol.
  [/^\/tareas(\/|$)/, ["administracion", "gerencia", "caja"]],
  [/^\/agenda(\/|$)/, ["administracion", "caja"]],
];

/** Ruta de aterrizaje de cada área (siempre permitida para quien tiene el área). */
const AREA_LANDING: Record<string, string> = {
  gerencia: "/dashboard",
  contabilidad: "/facturacion",
  // La cajera aterriza en su panel: lo primero que necesita ver al entrar es el
  // recaudo del día de SU caja, no el listado de movimientos.
  caja: "/dashboard",
  // El técnico aterriza en su agenda: lo primero que necesita ver al entrar es qué
  // visitas le tocan hoy y en qué orden. Su rendimiento sigue en /dashboard.
  tecnicos: "/mi-agenda",
  sistemas: "/configuracion",
  administracion: "/clientes",
};

/**
 * Lo que puede abrir el JEFE DE BODEGA (`inventory.admin`), que no tiene área
 * ninguna. Es la lista corta a propósito: son las rutas que la API ya le abre con
 * `@OrPermission(INV_PERMISSIONS.ADMIN)` —transferencias, equipos y bodegas de
 * `/api/network`—, ni una más. Darle un área entera en su lugar le habría abierto
 * también los datos de esa área, que no es lo que se quiere.
 */
const RUTAS_JEFE_BODEGA: RegExp[] = [/^\/red\/transferencias(\/|$)/, /^\/red\/disponibles(\/|$)/];

/** Su aterrizaje: la única pantalla que tiene. */
const LANDING_JEFE_BODEGA = "/red/transferencias";

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
    // El jefe de bodega pasa por su propia puerta: no tiene área, así que la
    // comprobación de arriba lo rebotaba SIEMPRE (también fuera de su pantalla, con
    // lo que quedaba dando vueltas sin poder entrar a nada).
    const jefeBodega = !!claims.inv && RUTAS_JEFE_BODEGA.some((re) => re.test(pathname));
    if (areas && !jefeBodega && !areas.some((a) => claims.areas!.includes(a))) {
      const mine = claims.areas[0];
      const dest = (mine && AREA_LANDING[mine]) || (claims.inv ? LANDING_JEFE_BODEGA : "/");
      return NextResponse.redirect(new URL(dest === pathname ? "/" : dest, req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals and static assets.
  //
  // `descargas/` queda fuera a propósito: es la carpeta de material comercial
  // (public/descargas) pensada para enviar por fuera de la empresa. Todo lo que
  // se deposite ahí es descargable SIN sesión, así que no debe contener datos de
  // clientes. Es el único directorio exento; el resto del sitio sigue detrás del
  // gate de sesión.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|descargas/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
