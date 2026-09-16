"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { Dropdown } from "./ui/Dropdown";
import { CommandPalette, OPEN_COMMAND_EVENT } from "./navbar/CommandPalette";
import { findCrumb } from "@/lib/nav";
import { useAuth } from "@/context/AuthProvider";
import { useSidebar } from "@/context/SidebarProvider";
import { useNotifications } from "@/context/NotificationsProvider";
import { PERM } from "@/lib/auth";
import { esTecnico } from "@/lib/support";

/** Alerta de inventario tal como la entrega el backend (/inventory/alerts). */
type InvAlert = {
  id: string;
  type: "LOW_STOCK" | "OUT_OF_STOCK";
  title: string;
  message: string;
  status: string;
  createdAt: string;
};

const ALERT_ICON: Record<InvAlert["type"], string> = {
  LOW_STOCK: "alert-triangle",
  OUT_OF_STOCK: "package-x",
};

/** "hace X" relativo, en español, a partir de una fecha ISO. */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d === 1 ? "" : "s"}`;
}

function fire(event: string) {
  window.dispatchEvent(new CustomEvent(event));
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const crumb = findCrumb(pathname);
  const { collapsed, toggle, isMobile, openMobile } = useSidebar();
  const { user, can, authFetch } = useAuth();

  // El buscador global (⌘K) no es del técnico de campo: busca en TODO el
  // espacio de trabajo —clientes, facturas, órdenes de cualquiera— y su perfil
  // está acotado a lo suyo. Se le quita el mando; el candado de verdad está en
  // el backend (`/search/ai` y el listado de `/subscribers` le responden 403).
  const sinBuscador = esTecnico(user);

  const canSeeAlerts = can(PERM.INV_STOCK_READ);
  const [alerts, setAlerts] = useState<InvAlert[]>([]);
  const alertasSinLeer = alerts.filter((a) => a.status === "PENDIENTE").length;

  // La campanita muestra DOS cosas de origen distinto: los avisos personales
  // (bandeja de WhatsApp y lo que venga después) y las alertas de inventario, que
  // son de stock y no de nadie en particular. Se cuentan juntas porque para quien
  // mira es una sola campana.
  const { items: avisos, unread: avisosSinLeer, marcarTodas, marcar } = useNotifications();
  const unread = avisosSinLeer + alertasSinLeer;

  const loadAlerts = useCallback(async () => {
    if (!user || !canSeeAlerts) return;
    try {
      // Una sola exploración por sesión (idempotente en backend) para refrescar.
      if (typeof window !== "undefined" && !sessionStorage.getItem("inv_alerts_scanned")) {
        sessionStorage.setItem("inv_alerts_scanned", "1");
        await authFetch("/inventory/alerts/run", { method: "POST" }).catch(() => {});
      }
      const res = await authFetch("/inventory/alerts");
      if (res.ok) setAlerts(await res.json());
    } catch {
      /* silencioso: la campana es best-effort */
    }
  }, [user, canSeeAlerts, authFetch]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts]);

  async function markAllRead() {
    setAlerts((list) => list.map((a) => ({ ...a, status: "LEIDA" })));
    await Promise.all([
      authFetch("/inventory/alerts/read-all", { method: "POST" }).catch(() => {}),
      marcarTodas(),
    ]);
  }

  /** Abre el aviso donde toque y lo da por leído. */
  function abrirAviso(n: { id: string; link: string | null }) {
    void marcar(n.id);
    if (n.link) router.push(n.link);
  }

  function openAlert(a: InvAlert) {
    // No hay centro de alertas dedicado: el listado de material con el filtro de
    // stock bajo muestra exactamente lo que la alerta reporta.
    router.push("/inventario?lowStock=1");
  }

  const squareBtn =
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-secondary transition-colors hover:bg-border-subtle";

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-4 sm:gap-4 sm:px-6">
      {/* menú: hamburguesa (abre drawer) en móvil · plegar riel en escritorio */}
      <button
        onClick={isMobile ? openMobile : toggle}
        title={isMobile ? "Abrir menú" : collapsed ? "Mostrar menú" : "Ocultar menú"}
        aria-label={isMobile ? "Abrir menú" : collapsed ? "Mostrar menú" : "Ocultar menú"}
        className={`-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-2 sm:-ml-2 ${
          collapsed && !isMobile ? "bg-surface-2" : ""
        }`}
      >
        <Icon
          name={isMobile ? "menu" : collapsed ? "panel-left" : "panel-left-close"}
          size={18}
        />
      </button>

      {/* breadcrumb dinámico — oculto en móvil para ahorrar espacio */}
      <div className="hidden min-w-0 items-center gap-2 sm:flex">
        <span className="truncate text-[13px] font-medium text-text-tertiary">{crumb.section}</span>
        <Icon name="chevron-right" size={14} className="shrink-0 text-text-tertiary" />
        <span className="truncate text-[13px] font-semibold text-text-primary">{crumb.label}</span>
      </div>

      {/* en móvil el título de la sección actual reemplaza al breadcrumb */}
      <span className="truncate text-[14px] font-semibold text-text-primary sm:hidden">
        {crumb.label}
      </span>

      <div className="flex-1" />

      {/* búsqueda global → abre la paleta de comandos (versión completa en ≥lg) */}
      {!sinBuscador && (
      <button
        onClick={() => fire(OPEN_COMMAND_EVENT)}
        className="hidden h-9 w-[260px] items-center gap-2 rounded-lg border border-border-subtle bg-canvas px-3 text-left transition-colors hover:border-border-default lg:flex xl:w-[340px]"
      >
        <Icon name="search" size={14} className="text-text-tertiary" />
        <span className="flex-1 text-[13px] text-text-tertiary">
          Buscar en todo el espacio de trabajo…
        </span>
        <kbd className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-text-tertiary">
          ⌘K
        </kbd>
      </button>
      )}

      {/* búsqueda compacta (icono) en móvil/tablet */}
      {!sinBuscador && (
      <button
        onClick={() => fire(OPEN_COMMAND_EVENT)}
        aria-label="Buscar"
        title="Buscar"
        className={`${squareBtn} lg:hidden`}
      >
        <Icon name="search" size={16} />
      </button>
      )}

      {/* El selector de color primario NO va aquí: se elige en Preferencias
          (/perfil?tab=preferencias). Es un ajuste que se toca una vez, no algo
          que merezca un botón permanente en la barra. */}

      <ThemeToggle />

      {/* notificaciones */}
      <Dropdown
        width={320}
        trigger={
          <div className={`relative ${squareBtn}`}>
            <Icon name="bell" size={16} />
            {unread > 0 && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border-[1.5px] border-surface-2 bg-error" />
            )}
          </div>
        }
      >
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1">
          <span className="text-[13px] font-bold text-text-primary">Notificaciones</span>
          {unread > 0 && (
            <button
              onClick={markAllRead}
              className="text-[11px] font-semibold text-brand hover:underline"
            >
              Marcar leídas
            </button>
          )}
        </div>
        {alerts.length === 0 && avisos.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <Icon name="check" size={18} className="text-text-tertiary" />
            <span className="text-[12px] text-text-tertiary">Sin notificaciones</span>
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            {/* Avisos personales primero: son los que piden una acción de QUIEN mira. */}
            {avisos.slice(0, 20).map((n) => (
              <button
                key={n.id}
                onClick={() => abrirAviso(n)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2 ${
                  n.leida ? "opacity-60" : ""
                }`}
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft">
                  <Icon
                    name={n.kind.startsWith("whatsapp") ? "message-circle" : "bell"}
                    size={13}
                    className="text-brand"
                  />
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="text-[12px] font-semibold text-text-primary">{n.title}</span>
                  {n.body && (
                    <span className="line-clamp-2 text-[11px] text-text-secondary">{n.body}</span>
                  )}
                  <span className="text-[11px] text-text-tertiary">{timeAgo(n.createdAt)}</span>
                </div>
              </button>
            ))}
            {alerts.slice(0, 20).map((a) => {
              const isUnread = a.status === "PENDIENTE";
              return (
                <button
                  key={a.id}
                  onClick={() => openAlert(a)}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2 ${
                    isUnread ? "" : "opacity-60"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      a.type === "OUT_OF_STOCK" ? "bg-error-soft" : "bg-warning-soft"
                    }`}
                  >
                    <Icon
                      name={ALERT_ICON[a.type]}
                      size={13}
                      className={a.type === "OUT_OF_STOCK" ? "text-error-text" : "text-warning-text"}
                    />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[12px] font-semibold text-text-primary">{a.title}</span>
                    <span className="text-[11px] text-text-secondary line-clamp-2">{a.message}</span>
                    <span className="text-[11px] text-text-tertiary">{timeAgo(a.createdAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Dropdown>

      {/* El menú de usuario (perfil / preferencias / salir) NO va aquí: vive al
          pie del sidebar, que es donde ya estaba el bloque con el nombre. Tenerlo
          en los dos sitios era la misma cosa dos veces. */}

      {/* overlays montados una vez con el navbar */}
      {!sinBuscador && <CommandPalette />}
    </header>
  );
}
