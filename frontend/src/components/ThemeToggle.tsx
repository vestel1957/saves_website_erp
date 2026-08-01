"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/**
 * Conmuta la clase `dark` en <html> y persiste la preferencia en localStorage.
 * La clase inicial la fija el script anti-parpadeo de layout.tsx antes de pintar,
 * así que aquí solo leemos el estado real del DOM al montar.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={dark ? "Modo claro" : "Modo oscuro"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-secondary transition-colors hover:bg-border-subtle"
    >
      {/* Evita el mismatch de hidratación: no renderiza el ícono hasta montar */}
      {mounted && <Icon name={dark ? "sun" : "moon"} size={16} />}
    </button>
  );
}
