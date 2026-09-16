"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { fijarDuenoDeFiltros } from "@/lib/useFiltrosUrl";
import {
  API_URL,
  apiLogin,
  can,
  clearTokenCookie,
  fetchMe,
  getTokenFromCookie,
  isSedeScoped,
  isSuperadmin,
  puedeEmitirNotas,
  setTokenCookie,
  type AuthUser,
} from "@/lib/auth";

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  isSuperadmin: boolean;
  /**
   * El usuario está acotado a unas sedes concretas (la cajera a la suya). Las
   * pantallas lo usan para NO pintar el filtro de sedes: no tiene entre qué elegir.
   */
  sedeScoped: boolean;
  /** Returns true if the user holds (any of) the required permission(s). */
  can: (required?: string | string[]) => boolean;
  /**
   * Puede emitir notas crédito/débito. NO se resuelve con `can()`: es un permiso
   * nominal que el superusuario no hereda (ver `lib/auth.ts`).
   */
  puedeEmitirNotas: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** fetch() that injects the Bearer token and handles 401 by logging out. */
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// ── Caché en memoria para catálogos estables ──────────────────────────────
// Sedes, bodegas, planes, roles, pantallas… cambian rarísima vez
// pero se re-piden en cada montaje de página (authFetch fuerza no-store). Se
// cachean por sesión con TTL corto; cualquier mutación (POST/PUT/PATCH/DELETE)
// vacía la caché para no servir datos viejos tras una edición.
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_PATHS = [
  "/inventory/warehouses",
  "/network/warehouses",
  "/config/branches",
  "/plans",
  "/auth/roles",
  "/auth/screens",
  "/auth/users/options",
];
const catalogCache = new Map<string, { text: string; exp: number }>();
const isCatalog = (path: string) => {
  const p = path.split("?")[0];
  return CATALOG_PATHS.some((c) => p === c || p.endsWith(c));
};
export const clearCatalogCache = () => catalogCache.clear();

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: AuthUser | null;
}) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(initialUser);
  const [loading, setLoading] = useState(!initialUser);

  // Los filtros que cada listado recuerda son de ESTE usuario (ver `useFiltrosUrl`).
  // Se fija al pintar y no en un efecto a propósito: los efectos de los hijos corren
  // ANTES que los del padre, así que en un efecto la lista habría leído los filtros
  // guardados antes de saber de quién son.
  if (typeof window !== "undefined") fijarDuenoDeFiltros(user?.id ?? null);

  const loadFromCookie = useCallback(async () => {
    const token = getTokenFromCookie();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await fetchMe(token);
      setUser(me);
    } catch {
      clearTokenCookie();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialUser) void loadFromCookie();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: u } = await apiLogin(email, password);
    setTokenCookie(token);
    setUser(u);
    setLoading(false);
    return u;
  }, []);

  const logout = useCallback(async () => {
    const token = getTokenFromCookie();
    // Best-effort server notification; logout is stateless so we don't block on it.
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
    } catch {
      /* ignore */
    }
    clearTokenCookie();
    clearCatalogCache();
    setUser(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = getTokenFromCookie();
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      // FormData debe llevar su propio Content-Type (con boundary) que fija el
      // navegador; solo forzamos JSON para cuerpos que no sean multipart.
      if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const url = path.startsWith("http") ? path : `${API_URL}${path}`;
      const method = (init.method ?? "GET").toUpperCase();

      // GET de un catálogo estable → servir de caché si está fresco.
      if (method === "GET" && isCatalog(path)) {
        const hit = catalogCache.get(path);
        if (hit && hit.exp > Date.now()) {
          return new Response(hit.text, { status: 200, headers: { "Content-Type": "application/json" } });
        }
      } else if (method !== "GET") {
        // Cualquier escritura invalida los catálogos (una edición pudo cambiarlos).
        catalogCache.clear();
      }

      const res = await fetch(url, { ...init, headers, cache: "no-store" });
      if (res.status === 401) {
        clearTokenCookie();
        setUser(null);
        router.replace("/login");
      }
      // Guardar en caché las respuestas de catálogo exitosas.
      if (method === "GET" && res.ok && isCatalog(path)) {
        catalogCache.set(path, { text: await res.clone().text(), exp: Date.now() + CATALOG_TTL_MS });
      }
      return res;
    },
    [router],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isSuperadmin: isSuperadmin(user),
      sedeScoped: isSedeScoped(user),
      can: (required) => can(user, required),
      puedeEmitirNotas: puedeEmitirNotas(user),
      login,
      logout,
      refresh: loadFromCookie,
      authFetch,
    }),
    [user, loading, login, logout, loadFromCookie, authFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
