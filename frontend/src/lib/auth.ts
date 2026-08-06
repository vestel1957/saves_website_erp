/**
 * Auth client helpers shared across the app.
 *
 * The backend issues a compact HMAC-signed token (JWT-shaped). We store it in a
 * non-httpOnly cookie (`nexus_token`) so that both the Next.js middleware (edge)
 * and client components can read it. The cookie is NOT the security boundary —
 * every protected API call is verified server-side by the NestJS guards. The
 * cookie + middleware only drive routing/UX.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export const TOKEN_COOKIE = "nexus_token";
const TOKEN_MAX_AGE = 60 * 60 * 12; // 12h, mirrors the backend TTL

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  /**
   * Sedes (`Branch.legacyId`) a las que llega el usuario. **Vacío = TODAS**, ojo con
   * la semántica: es la misma de `User.sedesAccede` en el backend. Lo resuelve la
   * sesión (`resolveUser`) uniendo las sedes marcadas con la sede de su caja.
   */
  sedes?: number[];
};

/**
 * ¿A este usuario le toca ver una sola parcela del sistema?
 *
 * Es la pregunta que hacen las pantallas para NO pintar el filtro de sedes: quien
 * está acotado (la cajera, típicamente) no elige sede — el backend le devuelve sólo
 * la suya, así que un desplegable con "Todas las sedes" sería una mentira y un
 * botón que no hace nada.
 */
export function isSedeScoped(user: Pick<AuthUser, "sedes"> | null | undefined): boolean {
  return !!user?.sedes?.length;
}

/** Permission keys — must mirror backend `permissions.catalog.ts`. */
export const PERM = {
  DASHBOARD_VIEW: "dashboard.view",
  ACCOUNTING_VIEW: "accounting.view",
  ACCOUNTING_MANAGE: "accounting.manage",
  HR_EMPLOYEES_READ: "hr.employees.read",
  HR_EMPLOYEES_WRITE: "hr.employees.write",
  HR_ACCESS_MANAGE: "hr.access.manage",
  USERS_MANAGE: "system.users.manage",
  WHATSAPP_MANAGE: "system.whatsapp",
  WHATSAPP_INBOX: "whatsapp.inbox",
  SYSTEM_ADMIN: "system.admin",
  PURCHASES_APPROVE: "purchases.approve",
  // áreas de acceso Vestel (visibilidad de secciones del sidebar)
  AREA_GERENCIA: "area.gerencia",
  AREA_ADMINISTRACION: "area.administracion",
  AREA_CONTABILIDAD: "area.contabilidad",
  AREA_TECNICOS: "area.tecnicos",
  AREA_SISTEMAS: "area.sistemas",
  AREA_CAJA: "area.caja",
  // inventory
  INV_ADMIN: "inventory.admin",
  INV_PRODUCTS_READ: "inventory.products.read",
  INV_PRODUCTS_WRITE: "inventory.products.write",
  INV_STOCK_READ: "inventory.stock.read",
  INV_KARDEX_READ: "inventory.kardex.read",
  INV_WAREHOUSES_READ: "inventory.warehouses.read",
  INV_WAREHOUSES_WRITE: "inventory.warehouses.write",
  INV_MOVEMENTS_WRITE: "inventory.movements.write",
  INV_PURCHASE_ORDERS_READ: "inventory.purchase-orders.read",
  INV_PURCHASE_ORDERS_WRITE: "inventory.purchase-orders.write",
  INV_PURCHASE_ORDERS_APPROVE: "inventory.purchase-orders.approve",
  INV_RECEIPTS_WRITE: "inventory.receipts.write",
  INV_ADJUSTMENTS_WRITE: "inventory.adjustments.write",
  INV_ADJUSTMENTS_APPROVE: "inventory.adjustments.approve",
  INV_REPORTS_READ: "inventory.reports.read",
  INV_WORK_ORDERS_WRITE: "inventory.work-orders.write",
  INV_WORK_ORDERS_EXECUTE: "inventory.work-orders.execute",
  INV_ASSETS_READ: "inventory.assets.read",
  INV_ASSETS_WRITE: "inventory.assets.write",
  INV_ASSETS_ASSIGN: "inventory.assets.assign",
  // payroll (nómina)
  PAYROLL_VIEW: "payroll.view",
  PAYROLL_ADMIN: "payroll.admin",
  PAYROLL_CONCEPTS_READ: "payroll.concepts.read",
  PAYROLL_CONCEPTS_WRITE: "payroll.concepts.write",
  PAYROLL_CONTRACTS_READ: "payroll.contracts.read",
  PAYROLL_CONTRACTS_WRITE: "payroll.contracts.write",
  PAYROLL_PERIODS_READ: "payroll.periods.read",
  PAYROLL_PERIODS_WRITE: "payroll.periods.write",
  PAYROLL_EVENTS_READ: "payroll.events.read",
  PAYROLL_EVENTS_WRITE: "payroll.events.write",
  PAYROLL_EVENTS_APPROVE: "payroll.events.approve",
  PAYROLL_PAYSLIPS_READ: "payroll.payslips.read",
  PAYROLL_PAYSLIPS_WRITE: "payroll.payslips.write",
  PAYROLL_SELF_READ: "payroll.self.read",
  PAYROLL_REPORTS_READ: "payroll.reports.read",
  PAYROLL_INTEGRATIONS_MANAGE: "payroll.integrations.manage",
} as const;

/**
 * Does `user` satisfy `required`? Mirrors the backend PermissionsGuard:
 *  - `system.admin` is the GLOBAL superadmin → passes everything.
 *  - `inventory.admin` is the inventory superuser → passes only `inventory.*`.
 * With multiple required permissions, ANY match grants access (matching how
 * nav/route gates express "you can see this if you hold any of these").
 */
export function can(
  user: Pick<AuthUser, "permissions"> | null | undefined,
  required?: string | string[],
): boolean {
  if (!user) return false;
  const granted = user.permissions ?? [];
  if (granted.includes(PERM.SYSTEM_ADMIN)) return true;
  if (!required) return true;
  const list = Array.isArray(required) ? required : [required];
  if (list.length === 0) return true;
  const hasInvAdmin = granted.includes(PERM.INV_ADMIN);
  return list.some((p) => granted.includes(p) || (hasInvAdmin && p.startsWith("inventory.")));
}

/** Global superadmin only (system.admin). Inventory admin is NOT global. */
export function isSuperadmin(user: Pick<AuthUser, "permissions"> | null | undefined): boolean {
  return !!user && (user.permissions ?? []).includes(PERM.SYSTEM_ADMIN);
}

/**
 * Quién es "un técnico en la calle" a efectos de ubicación: a quien se le exige
 * el permiso del navegador (`GeoGate`) y de quien se reporta la posición
 * mientras tiene la app abierta (`LatidoUbicacion`).
 *
 * Vive aquí, y no dentro de cada componente, porque son dos reglas que TIENEN
 * que decir lo mismo: exigirle la ubicación a alguien de quien luego no se
 * reporta nada —o al revés— es el tipo de desajuste que nadie nota hasta que
 * alguien pregunta por qué no sale en el mapa.
 *
 * Los mandos quedan fuera a propósito (mismos exentos que la geo-cerca del
 * cierre de órdenes): en un escritorio sin GPS el punto sería basura, y no es
 * información que el sistema tenga por qué recoger.
 */
export function esTecnicoDeCampo(
  user: Pick<AuthUser, "permissions"> | null | undefined,
): boolean {
  if (!user) return false;
  const granted = user.permissions ?? [];
  return (
    granted.includes(PERM.AREA_TECNICOS) &&
    !granted.includes(PERM.AREA_GERENCIA) &&
    !granted.includes(PERM.AREA_ADMINISTRACION) &&
    !granted.includes(PERM.SYSTEM_ADMIN)
  );
}

// ---- token cookie (client side) -------------------------------------------

export function getTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${TOKEN_COOKIE}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * `Secure` sólo cuando la página se sirve por HTTPS.
 *
 * Marcarla siempre rompería el desarrollo local (el navegador no envía cookies
 * `Secure` por http://localhost), y no marcarla nunca es lo que permitía que el
 * token viajara en claro. Como la entrada pública es ya exclusivamente HTTPS
 * —los puertos 3060/3061 sólo escuchan en 127.0.0.1—, en producción esto siempre
 * se activa.
 *
 * Falta `HttpOnly`, y no es un olvido: el propio frontend lee la cookie desde JS
 * en `getTokenFromCookie()` para firmar cada petición. Ponerla HttpOnly exige que
 * sea el backend quien la emita y que `authFetch` pase a `credentials: 'include'`.
 * Es un cambio de diseño, no un atributo.
 */
function atributosCookie(): string {
  const seguro = typeof location !== "undefined" && location.protocol === "https:";
  return `path=/; samesite=lax${seguro ? "; secure" : ""}`;
}

export function setTokenCookie(token: string) {
  document.cookie = `${TOKEN_COOKIE}=${token}; max-age=${TOKEN_MAX_AGE}; ${atributosCookie()}`;
}

export function clearTokenCookie() {
  document.cookie = `${TOKEN_COOKIE}=; max-age=0; ${atributosCookie()}`;
}

// ---- API calls -------------------------------------------------------------

export async function apiLogin(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let message = "No fue posible iniciar sesión.";
    try {
      const body = await res.json();
      if (res.status === 401) message = "Credenciales inválidas.";
      else if (body?.message) message = String(body.message);
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return res.json();
}

/** Fetches the current user (fresh permissions) using the cookie token. */
export async function fetchMe(token: string): Promise<AuthUser> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("session-invalid");
  return res.json();
}

/** Initials for an avatar, e.g. "Camila Contadora" → "CC". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
