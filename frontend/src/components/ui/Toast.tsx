"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";

type ToastMsg = { id: number; text: string; icon: string };

const EVENT = "nexus:toast";
let counter = 1;

/** Dispara un toast desde cualquier parte del cliente. */
export function toast(text: string, icon = "check") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { text, icon } }));
}

/** Contenedor montado una sola vez (en el layout) que escucha y renderiza toasts. */
export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);

  useEffect(() => {
    function onToast(e: Event) {
      const { text, icon } = (e as CustomEvent).detail as {
        text: string;
        icon: string;
      };
      const id = counter++;
      setItems((prev) => [...prev, { id, text, icon }]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, 2800);
    }
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5 text-[13px] font-medium text-text-primary shadow-xl shadow-black/10"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-soft">
            <Icon name={t.icon} size={12} className="text-brand" />
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
