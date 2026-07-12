"use client";

import { createContext, useContext, useEffect, useState } from "react";

type SidebarCtx = {
  /** Modo riel (solo iconos) en escritorio. */
  collapsed: boolean;
  /** Alterna el modo riel en escritorio. */
  toggle: () => void;
  setCollapsed: (v: boolean) => void;
  /** true cuando el viewport es de tamaño móvil/tablet (< lg). */
  isMobile: boolean;
  /** Drawer del menú abierto en móvil. */
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;
};

const Ctx = createContext<SidebarCtx | null>(null);
const STORAGE_KEY = "nexus:sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 1023px)"; // coincide con el breakpoint lg de Tailwind

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Restaura la preferencia guardada al montar.
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);

  // Observa el breakpoint para saber si estamos en móvil; cierra el drawer al
  // volver a escritorio para que el menú no quede "atascado" abierto.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setMobileOpen(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Bloquea el scroll del body mientras el drawer está abierto en móvil.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileOpen]);

  const persist = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const toggle = () => persist(!collapsed);
  const openMobile = () => setMobileOpen(true);
  const closeMobile = () => setMobileOpen(false);

  return (
    <Ctx.Provider
      value={{
        collapsed,
        toggle,
        setCollapsed: persist,
        isMobile,
        mobileOpen,
        openMobile,
        closeMobile,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSidebar(): SidebarCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSidebar debe usarse dentro de <SidebarProvider>");
  return ctx;
}
