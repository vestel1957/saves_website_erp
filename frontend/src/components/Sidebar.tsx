"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";
import { navSections, activeNavHref, type NavItem, type NavSection } from "@/lib/nav";
import { useAuth } from "@/context/AuthProvider";
import { useSidebar } from "@/context/SidebarProvider";
import { can, initials } from "@/lib/auth";

function rowClass(active: boolean, collapsed: boolean) {
  return `group relative flex w-full items-center rounded-md text-left text-[13px] transition-colors ${
    collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2"
  } ${
    active
      ? "bg-sidebar-active font-semibold text-text-primary"
      : "font-medium text-text-sidebar hover:bg-sidebar-hover"
  }`;
}

function RowContent({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <>
      {/* barra de acento izquierda del ítem activo (solo expandido) */}
      {active && !collapsed && (
        <span className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />
      )}
      <Icon
        name={item.icon}
        size={16}
        className={active ? "text-brand" : item.iconClass ?? "text-text-sidebar"}
      />
      {!collapsed && <span className="flex-1">{item.label}</span>}
      {!collapsed &&
        item.badge &&
        (item.badgeKind === "ai" ? (
          <span className="ai-gradient rounded-full px-1.5 py-px text-[9px] font-bold text-white">
            {item.badge}
          </span>
        ) : (
          <span className="rounded-full bg-sidebar-hover px-1.5 py-px text-[10px] font-semibold text-text-secondary">
            {item.badge}
          </span>
        ))}
    </>
  );
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const title = collapsed ? item.label : undefined;
  if (item.href) {
    return (
      <Link href={item.href} title={title} className={rowClass(active, collapsed)}>
        <RowContent item={item} active={active} collapsed={collapsed} />
      </Link>
    );
  }
  return (
    <button title={title} className={rowClass(active, collapsed)}>
      <RowContent item={item} active={active} collapsed={collapsed} />
    </button>
  );
}

function isActive(item: NavItem, pathname: string) {
  // Activo solo el ítem de coincidencia más específica → nunca dos resaltados.
  return !!item.href && item.href === activeNavHref(pathname);
}

/** Hojas con href de un ítem (recorre hijos). */
function itemLeaves(item: NavItem): NavItem[] {
  if (item.children?.length) return item.children.flatMap(itemLeaves);
  return item.href ? [item] : [];
}

/**
 * Módulo colapsable (has-sub del legacy): fila padre que abre/cierra su submenú.
 * Arranca abierto si contiene la ruta activa y se reabre al navegar a un hijo.
 */
function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const activeHref = activeNavHref(pathname);
  const hasActiveChild = itemLeaves(item).some((l) => l.href === activeHref);
  const [open, setOpen] = useState(hasActiveChild);
  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  return (
    <div className="flex flex-col">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${rowClass(false, false)} ${hasActiveChild ? "text-text-primary" : ""}`}
      >
        <Icon name={item.icon} size={16} className={item.iconClass ?? "text-text-sidebar"} />
        <span className="flex-1">{item.label}</span>
        <Icon
          name="chevron-down"
          size={13}
          className={`shrink-0 text-text-sidebar-muted transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border-subtle pl-2.5">
          {(item.children ?? []).map((child) => (
            <NavRow
              key={child.label}
              item={child}
              active={isActive(child, pathname)}
              collapsed={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavSection({
  section,
  pathname,
  collapsed,
  open,
  onToggle,
}: {
  section: NavSection;
  pathname: string;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  // Modo riel: solo iconos (aplanando submódulos a sus hojas); separador entre grupos.
  if (collapsed) {
    return (
      <div className="flex flex-col gap-0.5 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
        {section.items.flatMap(itemLeaves).map((item) => (
          <NavRow
            key={item.label}
            item={item}
            active={isActive(item, pathname)}
            collapsed
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 px-2.5 pb-1.5 pt-1 text-[10px] font-semibold tracking-wider text-text-sidebar-muted transition-colors hover:text-text-sidebar"
      >
        <Icon
          name="chevron-down"
          size={12}
          className={`transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span>{section.title}</span>
      </button>

      {open && (
        <div className="ml-4 mt-0.5 flex flex-col gap-0.5 border-l border-border-subtle pl-3">
          {section.items.map((item) =>
            item.children?.length ? (
              <NavGroup key={item.label} item={item} pathname={pathname} />
            ) : (
              <NavRow key={item.label} item={item} active={isActive(item, pathname)} collapsed={false} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Deja solo las secciones/ítems/hijos que el usuario puede ver.
 * - Filtra en profundidad: un submenú se conserva solo si le queda ≥1 hijo visible.
 * - Deduplica por href (la 1ª aparición gana): una pantalla compartida entre
 *   áreas (p.ej. Tickets en técnicos y caja) nunca se repite en el menú.
 * - La sección se muestra si le queda ≥1 ítem (su visibilidad la derivan sus ítems).
 */
function visibleSections(
  sections: NavSection[],
  check: (perm?: string | string[]) => boolean,
): NavSection[] {
  const seen = new Set<string>();
  const keep = (item: NavItem): NavItem | null => {
    if (item.children?.length) {
      const children = item.children.map(keep).filter(Boolean) as NavItem[];
      return children.length ? { ...item, children } : null;
    }
    if (!check(item.perm)) return null;
    if (item.href) {
      if (seen.has(item.href)) return null;
      seen.add(item.href);
    }
    return item;
  };
  return sections
    .map((s) => ({ ...s, items: s.items.map(keep).filter(Boolean) as NavItem[] }))
    .filter((s) => s.items.length > 0);
}

/** Título de la sección que contiene la ruta activa (para auto-abrir el acordeón). */
function sectionOf(pathname: string): string | null {
  const href = activeNavHref(pathname);
  if (!href) return null;
  for (const s of navSections) {
    if (s.items.flatMap(itemLeaves).some((l) => l.href === href)) return s.title;
  }
  return null;
}

export function Sidebar() {
  const pathname = usePathname();
  const { user, loading, logout } = useAuth();
  const { collapsed, isMobile, mobileOpen, closeMobile } = useSidebar();

  // Acordeón: una sección abierta a la vez; arranca en la de la ruta actual.
  const [openSection, setOpenSection] = useState<string | null>(() => sectionOf(pathname));
  useEffect(() => {
    const s = sectionOf(pathname);
    if (s) setOpenSection(s);
  }, [pathname]);

  // En móvil el menú es un drawer que siempre se muestra expandido (con etiquetas);
  // el modo riel (solo iconos) aplica únicamente en escritorio.
  const railMode = collapsed && !isMobile;

  // Cierra el drawer al navegar a otra ruta (clic en un ítem del menú).
  useEffect(() => {
    if (mobileOpen) closeMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const check = (perm?: string | string[]) => can(user, perm);
  const sections = visibleSections(navSections, check);
  const roleLabel = user?.roles?.[0] ?? "Sin rol asignado";

  return (
    <>
      {/* backdrop del drawer (solo móvil) */}
      <div
        onClick={closeMobile}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 lg:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-screen flex-col overflow-hidden border-r border-border-subtle bg-sidebar transition-transform duration-300 ease-in-out lg:static lg:z-auto lg:translate-x-0 lg:shrink-0 lg:transition-[width] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } ${railMode ? "w-[68px]" : "w-[260px]"}`}
      >
        {/* cabecera — alineada con el navbar (h-16 + border-b) */}
        <div
          className={`flex h-16 shrink-0 items-center border-b border-border-subtle ${
            railMode ? "justify-center px-2" : "gap-2.5 px-4"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-vestel.png" alt="Vestel" className="h-9 w-auto shrink-0" />
          {/* cerrar drawer (solo móvil) */}
          <button
            onClick={closeMobile}
            aria-label="Cerrar menú"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-sidebar-muted transition-colors hover:bg-sidebar-hover lg:hidden"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <nav
          className={`no-scrollbar flex flex-1 flex-col gap-1 overflow-y-auto py-4 ${
            railMode ? "px-2" : "px-3"
          }`}
        >
          {loading && !user ? (
            <div className="flex flex-col gap-2 px-2.5 pt-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="h-7 animate-pulse rounded-md bg-sidebar-hover"
                  style={{ opacity: 1 - i * 0.1 }}
                />
              ))}
            </div>
          ) : (
            sections.map((section) => (
              <NavSection
                key={section.title}
                section={section}
                pathname={pathname}
                collapsed={railMode}
                open={openSection === section.title}
                onToggle={() => setOpenSection((cur) => (cur === section.title ? null : section.title))}
              />
            ))
          )}
        </nav>

        {/* user */}
        <div className={railMode ? "px-2 pb-4" : "px-3 pb-4"}>
          <div
            className={`flex items-center gap-2 border-t border-sidebar-hover pt-3 ${
              railMode ? "justify-center" : ""
            }`}
          >
            {railMode ? (
            <span
              title={user?.name ?? "Invitado"}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white"
            >
              {user ? initials(user.name) : "··"}
            </span>
          ) : (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
                  {user ? initials(user.name) : "··"}
                </span>
                <div className="flex min-w-0 flex-col text-left leading-tight">
                  <span className="truncate text-[13px] font-semibold text-text-primary">
                    {user?.name ?? "Invitado"}
                  </span>
                  <span className="truncate text-[11px] text-text-sidebar-muted">{roleLabel}</span>
                </div>
              </div>
              <button
                onClick={() => void logout()}
                title="Cerrar sesión"
                aria-label="Cerrar sesión"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-error-text"
              >
                <Icon name="log-out" size={16} />
              </button>
            </>
          )}
          </div>
        </div>
      </aside>
    </>
  );
}
