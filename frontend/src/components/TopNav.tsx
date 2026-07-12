"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { BrandColorPicker } from "./BrandColorPicker";
import { Dropdown, MenuItem } from "./ui/Dropdown";
import { toast } from "./ui/Toast";
import { CommandPalette, OPEN_COMMAND_EVENT } from "./navbar/CommandPalette";
import { findCrumb } from "@/lib/nav";
import { useAuth } from "@/context/AuthProvider";
import { useSidebar } from "@/context/SidebarProvider";
import { initials, PERM } from "@/lib/auth";

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
  const { user, logout, can, authFetch } = useAuth();
  const avatar = user ? initials(user.name) : "··";
  const roleLabel = user?.roles?.[0] ?? "Sin rol";

  const canSeeAlerts = can(PERM.INV_STOCK_READ);
  const [alerts, setAlerts] = useState<InvAlert[]>([]);
  const unread = alerts.filter((a) => a.status === "PENDIENTE").length;

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
    await authFetch("/inventory/alerts/read-all", { method: "POST" }).catch(() => {});
  }

  function openAlert(a: InvAlert) {
    // Centro de alertas de inventario.
    router.push("/inventario/alertas");
  }

  const squareBtn =
    "flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-text-secondary transition-colors hover:bg-border-subtle";

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

      {/* búsqueda compacta (icono) en móvil/tablet */}
      <button
        onClick={() => fire(OPEN_COMMAND_EVENT)}
        aria-label="Buscar"
        title="Buscar"
        className={`${squareBtn} lg:hidden`}
      >
        <Icon name="search" size={16} />
      </button>

      <BrandColorPicker />

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
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <Icon name="check" size={18} className="text-text-tertiary" />
            <span className="text-[12px] text-text-tertiary">
              {canSeeAlerts ? "Sin alertas de inventario" : "Sin notificaciones"}
            </span>
          </div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
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

      {/* usuario */}
      <Dropdown
        width={240}
        trigger={
          <div className="flex h-9 items-center gap-2 rounded-full bg-surface-2 px-1 pr-2 transition-colors hover:bg-border-subtle">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">
              {avatar}
            </span>
            <Icon name="chevron-down" size={14} className="text-text-secondary" />
          </div>
        }
      >
        {({ close }) => (
          <>
            <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-1">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-white">
                {avatar}
              </span>
              <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-semibold text-text-primary">
                  {user?.name ?? "Invitado"}
                </span>
                <span className="truncate text-[11px] text-text-tertiary">
                  {user?.email ?? roleLabel}
                </span>
              </div>
            </div>
            <div className="px-2.5 pb-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-semibold text-brand">
                <Icon name="shield-check" size={11} /> {roleLabel}
              </span>
            </div>
            <div className="my-1 h-px bg-border-subtle" />
            <MenuItem onClick={() => { close(); toast("Perfil — módulo en construcción", "user"); }}>
              <Icon name="user" size={15} className="text-text-tertiary" /> Mi perfil
            </MenuItem>
            <MenuItem onClick={() => { close(); toast("Configuración — módulo en construcción", "settings"); }}>
              <Icon name="settings" size={15} className="text-text-tertiary" /> Configuración
            </MenuItem>
            <div className="my-1 h-px bg-border-subtle" />
            <MenuItem danger onClick={() => { close(); void logout(); }}>
              <Icon name="log-out" size={15} className="text-error-text" /> Cerrar sesión
            </MenuItem>
          </>
        )}
      </Dropdown>

      {/* overlays montados una vez con el navbar */}
      <CommandPalette />
    </header>
  );
}
