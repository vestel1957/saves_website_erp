"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "./AuthProvider";

export type Notificacion = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  leida: boolean;
  createdAt: string;
};

type Estado = {
  items: Notificacion[];
  unread: number;
  /** Sin leer por módulo (`whatsapp`, …), para los distintivos del menú. */
  porModulo: Record<string, number>;
  refrescar: () => Promise<void>;
  marcarTodas: () => Promise<void>;
  marcar: (id: string) => Promise<void>;
};

const Ctx = createContext<Estado>({
  items: [],
  unread: 0,
  porModulo: {},
  refrescar: async () => {},
  marcarTodas: async () => {},
  marcar: async () => {},
});

/** Cada cuánto se pregunta por avisos nuevos. */
const SONDEO_MS = 20_000;

/** Icono del toast según el tipo de aviso. */
const ICONO: Record<string, string> = {
  "whatsapp.mensaje": "message-circle",
  "whatsapp.asignado": "user-check",
  "agenda.evento": "calendar-days",
};

/**
 * Avisos personales: sondea el backend y avisa por toast de los que llegan mientras
 * la persona está mirando.
 *
 * WhatsApp no empuja nada al navegador y aquí no hay WebSocket: se pregunta cada 20 s
 * y, además, **al volver a la pestaña** — que es cuando de verdad importa, porque
 * quien atiende deja el ERP abierto en segundo plano.
 *
 * El toast solo salta con lo que aparece DESPUÉS del primer sondeo. Si no, al entrar
 * te caerían encima diez toasts de cosas que ya sabías: el toast es para enterarte de
 * algo nuevo, la campanita es para consultar lo pendiente.
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { user, authFetch } = useAuth();
  const [items, setItems] = useState<Notificacion[]>([]);
  const [unread, setUnread] = useState(0);
  const [porModulo, setPorModulo] = useState<Record<string, number>>({});

  /** Ids ya vistos por ESTA pestaña; el primer sondeo solo los memoriza. */
  const vistos = useRef<Set<string> | null>(null);

  const refrescar = useCallback(async () => {
    if (!user) return;
    try {
      const r = await authFetch("/notifications");
      if (!r.ok) return;
      const data = await r.json();
      const lista: Notificacion[] = data.items ?? [];
      setItems(lista);
      setUnread(data.unread ?? 0);
      setPorModulo(data.porModulo ?? {});

      const sinLeer = lista.filter((n) => !n.leida);
      if (vistos.current === null) {
        vistos.current = new Set(sinLeer.map((n) => n.id));
        return; // primera carga: nada de toasts
      }
      for (const n of sinLeer) {
        if (vistos.current.has(n.id)) continue;
        vistos.current.add(n.id);
        toast(n.title, ICONO[n.kind] ?? "bell");
      }
    } catch {
      /* silencioso: la campanita es best-effort, no puede romper la app */
    }
  }, [user, authFetch]);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnread(0);
      setPorModulo({});
      vistos.current = null;
      return;
    }
    void refrescar();
    const t = setInterval(() => void refrescar(), SONDEO_MS);
    const alVolver = () => {
      if (document.visibilityState === "visible") void refrescar();
    };
    document.addEventListener("visibilitychange", alVolver);
    window.addEventListener("focus", alVolver);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", alVolver);
      window.removeEventListener("focus", alVolver);
    };
  }, [user, refrescar]);

  const marcarTodas = useCallback(async () => {
    setItems((l) => l.map((n) => ({ ...n, leida: true })));
    setUnread(0);
    setPorModulo({});
    await authFetch("/notifications/read-all", { method: "POST" }).catch(() => {});
    void refrescar();
  }, [authFetch, refrescar]);

  const marcar = useCallback(
    async (id: string) => {
      setItems((l) => l.map((n) => (n.id === id ? { ...n, leida: true } : n)));
      setUnread((u) => Math.max(0, u - 1));
      await authFetch(`/notifications/${id}/read`, { method: "POST" }).catch(() => {});
      void refrescar();
    },
    [authFetch, refrescar],
  );

  const value = useMemo(
    () => ({ items, unread, porModulo, refrescar, marcarTodas, marcar }),
    [items, unread, porModulo, refrescar, marcarTodas, marcar],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useNotifications = () => useContext(Ctx);
