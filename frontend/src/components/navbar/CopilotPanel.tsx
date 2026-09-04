"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";

export const OPEN_COPILOT_EVENT = "nexus:copilot";

type Msg = { id: number; from: "ai" | "me"; text: string };

const GREETING: Msg = {
  id: 0,
  from: "ai",
  text: "¡Hola! Soy el Copiloto de Vestel. Pregúntame sobre tus ingresos, pipeline, inventario o el cierre contable.",
};

const CANNED = [
  "Revisé tus datos: los ingresos del mes van 12,4 % por encima del mes anterior. ¿Quieres el desglose por región?",
  "Tienes 5 negocios por $284K estancados en negociación más de 30 días. Te recomiendo priorizar Acme Corp.",
  "El nivel de servicio del inventario bajó 1,2 pt. Hay 8 SKUs por reabastecer en la bodega de Berlín.",
  "Claro, puedo generar ese reporte. (Demo: aún no conectado a un backend de IA.)",
];

export function CopilotPanel() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [draft, setDraft] = useState("");
  const idRef = useRef(1);
  const turnRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener(OPEN_COPILOT_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_COPILOT_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, open]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    const mine: Msg = { id: idRef.current++, from: "me", text };
    setMsgs((m) => [...m, mine]);
    setDraft("");
    const reply = CANNED[turnRef.current % CANNED.length];
    turnRef.current++;
    setTimeout(() => {
      setMsgs((m) => [...m, { id: idRef.current++, from: "ai", text: reply }]);
    }, 600);
  }

  return (
    <>
      {/* overlay */}
      <div
        className={`fixed inset-0 z-[80] bg-black/30 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setOpen(false)}
      />

      {/* panel */}
      <aside
        className={`fixed right-0 top-0 z-[81] flex h-dvh w-full max-w-[88vw] flex-col border-l border-border-subtle bg-surface shadow-2xl transition-transform duration-300 sm:w-[380px] sm:max-w-[380px] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3.5">
          <div className="ai-gradient flex h-8 w-8 items-center justify-center rounded-lg">
            <Icon name="sparkles" size={16} className="text-white" />
          </div>
          <div className="flex flex-1 flex-col leading-tight">
            <span className="text-sm font-bold text-text-primary">Copiloto Vestel</span>
            <span className="text-[11px] text-text-tertiary">Asistente del espacio de trabajo</span>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Cerrar"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-surface-2"
          >
            <Icon name="x" size={16} />
          </button>
        </header>

        <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {msgs.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                m.from === "me"
                  ? "self-end bg-brand text-on-brand"
                  : "self-start bg-surface-2 text-text-primary"
              }`}
            >
              {m.text}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle p-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Escribe tu pregunta…"
            className="h-10 flex-1 rounded-lg border border-border-subtle bg-canvas px-3 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus"
          />
          <button
            onClick={send}
            aria-label="Enviar"
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand text-on-brand transition-colors hover:bg-brand-hover"
          >
            <Icon name="send" size={16} className="text-on-brand" />
          </button>
        </div>
      </aside>
    </>
  );
}
