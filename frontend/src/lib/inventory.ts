import { cookies } from "next/headers";
import type {
  InventoryOverview,
  Product,
  Warehouse,
  StockRow,
  KardexRow,
  MovementRow,
  PurchaseOrder,
  ValuedReport,
  RotationRow,
  ReorderSuggestion,
} from "./inventory-shared";

// Re-export de tipos y helpers puros para compatibilidad con imports existentes.
// Server Components y código server-only pueden seguir importando desde "@/lib/inventory".
export * from "./inventory-shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export const TOKEN_COOKIE = "nexus_token";

/** Raised when the inventory API rejects the request for missing/invalid auth. */
export class AuthRequiredError extends Error {
  constructor() {
    super("AUTH_REQUIRED");
    this.name = "AuthRequiredError";
  }
}

/** Server-side GET that forwards the JWT stored in the cookie as a Bearer token. */
async function get<T>(path: string): Promise<T> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new Error(`Error ${res.status} al cargar ${path}`);
  return res.json();
}

// ---- dashboard -----------------------------------------------------------
export const getInventoryOverview = () => get<InventoryOverview>("/inventory/dashboard/overview");

// ---- catalog -------------------------------------------------------------
export const getProducts = (search = "") =>
  get<Product[]>(`/inventory/products${search ? `?search=${encodeURIComponent(search)}` : ""}`);
export const getWarehouses = () => get<Warehouse[]>("/inventory/warehouses");

// ---- stock & kardex ------------------------------------------------------
export const getStock = (warehouseId?: string) =>
  get<StockRow[]>(`/inventory/stock${warehouseId ? `?warehouseId=${warehouseId}` : ""}`);
export const getKardex = (productId: string) =>
  get<KardexRow[]>(`/inventory/kardex?productId=${productId}`);
export const getMovements = () => get<MovementRow[]>("/inventory/movements");

// ---- procurement ---------------------------------------------------------
export const getPurchaseOrders = () => get<PurchaseOrder[]>("/inventory/purchase-orders");

// ---- reports -------------------------------------------------------------
export const getValuedReport = () => get<ValuedReport>("/inventory/reports/valued");
export const getRotationReport = () => get<RotationRow[]>("/inventory/reports/rotation");
export const getReorderSuggestions = () => get<ReorderSuggestion[]>("/inventory/reorder/suggestions");
