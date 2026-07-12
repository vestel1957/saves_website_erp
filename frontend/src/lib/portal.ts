// Cliente del portal de autoservicio del abonado. Usa un token propio guardado
// en localStorage (separado del staff, que va por cookie nexus_token).
import { API_URL } from "@/lib/auth";

export const PORTAL_TOKEN_KEY = "portal_token";

export const getPortalToken = () =>
  typeof window !== "undefined" ? localStorage.getItem(PORTAL_TOKEN_KEY) : null;
export const setPortalToken = (t: string) => localStorage.setItem(PORTAL_TOKEN_KEY, t);
export const clearPortalToken = () => localStorage.removeItem(PORTAL_TOKEN_KEY);

/** fetch() al API con el Bearer del abonado. */
export async function portalFetch(path: string, init?: RequestInit) {
  const token = getPortalToken();
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store" });
}

export type PortalInvoice = { id: string; tid: number; date: string; dueDate: string | null; total: number; saldo: number };
export type PortalMe = {
  subscriber: { id: string; abonado: number; name: string; email: string | null; address: string | null };
  debt: number;
  invoices: PortalInvoice[];
};
