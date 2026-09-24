"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input, Field } from "@/components/ui/Field";
import { datePresets } from "@/lib/reportes";

/** El mensaje de error que devolvió la API, o uno por defecto. */
export async function errorDe(res: Response, porDefecto: string): Promise<string> {
  const m = await res.json().catch(() => null);
  return (Array.isArray(m?.message) ? m.message[0] : m?.message) || porDefecto;
}

/** Fecha y hora del alta, siempre en hora de Bogotá (el dato es un timestamp). */
export const fechaHora = (d: string | null | undefined) =>
  d
    ? new Date(d).toLocaleString("es-CO", {
        day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
        timeZone: "America/Bogota",
      })
    : "—";

/**
 * Rango de fechas en la URL (`?from=&to=`): así el rango viaja de la lista al detalle
 * de un funcionario y se puede compartir el enlace.
 */
export function useRangoUrl() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const set = useCallback(
    (f: string, t: string) => {
      const qs = new URLSearchParams();
      if (f) qs.set("from", f);
      if (t) qs.set("to", t);
      router.replace(`${pathname}${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname],
  );
  const query = `${from ? `from=${from}` : ""}${from && to ? "&" : ""}${to ? `to=${to}` : ""}`;
  return { from, to, set, query };
}

export function FiltroFechas({ from, to, set }: { from: string; to: string; set: (f: string, t: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-end">
        <Field label="Desde"><Input type="date" value={from} onChange={(e) => set(e.target.value, to)} /></Field>
        <Field label="Hasta"><Input type="date" value={to} onChange={(e) => set(from, e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {datePresets().map((p) => (
          <button key={p.label} onClick={() => set(p.from, p.to)}
            className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-[11px] font-medium text-text-secondary hover:bg-surface-2">
            {p.label}
          </button>
        ))}
        {(from || to) && (
          <button onClick={() => set("", "")}
            className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-[11px] font-medium text-text-secondary hover:bg-surface-2">
            Todo el historial
          </button>
        )}
      </div>
    </div>
  );
}
