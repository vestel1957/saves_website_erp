"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { nfmt } from "@/lib/reportes";

/**
 * Cuánto vale cada tipo de orden, de 1 a 5.
 *
 * El puntaje es automático: nadie califica al técnico al cerrar. Lo que se
 * decide aquí —una vez, y arriba— es cuánto pesa cada trabajo; al cerrar la
 * orden el sistema copia ese peso y no pregunta nada. Ver
 * `backend/src/support/order-score.policy.ts`.
 */

type Fila = {
  tipo: string;
  puntos: number;
  origen: "definido" | "sugerido";
  sugerido: number;
  campo: boolean;
  usos: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

type Catalogo = { min: number; max: number; tipos: Fila[] };

/** Las cinco estrellas de una fila. Es un radio, no un rango: 3 no es "más que 2". */
function Estrellas({
  valor,
  max,
  cambiado,
  onPick,
}: {
  valor: number;
  max: number;
  cambiado: boolean;
  onPick: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Puntaje">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={n === valor}
          aria-label={`${n} ${n === 1 ? "punto" : "puntos"}`}
          onClick={() => onPick(n)}
          className={`tap rounded p-0.5 transition-colors ${
            n <= valor
              ? cambiado
                ? "text-warning-text"
                : "text-brand"
              : "text-border-subtle hover:text-text-tertiary"
          }`}
        >
          <Icon name="star" size={17} className={n <= valor ? "fill-current" : undefined} />
        </button>
      ))}
      <span className="ml-1.5 w-3 text-[12px] font-semibold tabular-nums text-text-secondary">{valor}</span>
    </div>
  );
}

export default function PuntajesPage() {
  const { authFetch } = useAuth();
  const [cat, setCat] = useState<Catalogo | null>(null);
  /** Sólo lo que el usuario tocó en esta sesión: tipo → puntos. */
  const [cambios, setCambios] = useState<Record<string, number>>({});
  const [busca, setBusca] = useState("");
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(() => {
    void authFetch("/support/order-scores")
      .then((r) => (r.ok ? r.json() : null))
      .then(setCat)
      .catch(() => setCat(null));
  }, [authFetch]);
  useEffect(() => { cargar(); }, [cargar]);

  const filas = useMemo(() => {
    if (!cat) return [];
    const q = busca.trim().toLowerCase();
    return q ? cat.tipos.filter((t) => t.tipo.toLowerCase().includes(q)) : cat.tipos;
  }, [cat, busca]);

  const campo = filas.filter((f) => f.campo);
  const otros = filas.filter((f) => !f.campo);
  const pendientes = Object.keys(cambios).length;

  const puntosDe = (f: Fila) => cambios[f.tipo] ?? f.puntos;

  function fijar(f: Fila, n: number) {
    setCambios((c) => {
      const siguiente = { ...c };
      // Volver al valor con el que llegó la fila = no es un cambio. Así el
      // contador de pendientes dice la verdad y no se guarda ruido.
      if (n === f.puntos) delete siguiente[f.tipo];
      else siguiente[f.tipo] = n;
      return siguiente;
    });
  }

  async function guardar() {
    if (!pendientes) return;
    setGuardando(true);
    try {
      const res = await authFetch("/support/order-scores", {
        method: "PUT",
        body: JSON.stringify({
          puntajes: Object.entries(cambios).map(([tipo, puntos]) => ({ tipo, puntos })),
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(`${pendientes} ${pendientes === 1 ? "puntaje guardado" : "puntajes guardados"}`, "check");
      setCambios({});
      cargar();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  /** Quitar el valor fijado a mano: el tipo vuelve al sugerido del sistema. */
  async function volverAlSugerido(f: Fila) {
    setGuardando(true);
    try {
      const res = await authFetch("/support/order-scores", {
        method: "PUT",
        body: JSON.stringify({ puntajes: [{ tipo: f.tipo, puntos: null }] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(`"${f.tipo}" vuelve a ${f.sugerido} ${f.sugerido === 1 ? "punto" : "puntos"}`, "check");
      setCambios((c) => { const s = { ...c }; delete s[f.tipo]; return s; });
      cargar();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  function Grupo({ titulo, nota, filas: rows }: { titulo: string; nota: string; filas: Fila[] }) {
    if (!rows.length) return null;
    return (
      <div className="space-y-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{titulo}</div>
          <p className="text-[12px] text-text-tertiary">{nota}</p>
        </div>
        {rows.map((f) => {
          const v = puntosDe(f);
          const cambiado = cambios[f.tipo] != null;
          return (
            <div
              key={f.tipo}
              className={`flex flex-col gap-2 rounded-xl border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between ${
                cambiado ? "border-warning-border" : "border-border-subtle"
              }`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-text-primary">{f.tipo}</span>
                  {f.origen === "definido" && !cambiado && <Badge tone="info" label="fijado a mano" />}
                  {cambiado && <Badge tone="warning" label="sin guardar" />}
                </div>
                <div className="mt-0.5 text-[12px] text-text-tertiary">
                  {f.usos > 0 ? `${nfmt(f.usos)} órdenes en el último año` : "Sin uso en el último año"}
                  {f.origen === "definido" && f.updatedBy ? ` · lo fijó ${f.updatedBy}` : ""}
                  {f.origen === "sugerido" ? ` · sugerido por el sistema` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Estrellas valor={v} max={cat!.max} cambiado={cambiado} onPick={(n) => fijar(f, n)} />
                {f.origen === "definido" && !cambiado && f.puntos !== f.sugerido && (
                  <button
                    type="button"
                    disabled={guardando}
                    onClick={() => void volverAlSugerido(f)}
                    className="whitespace-nowrap text-[12px] text-text-tertiary hover:text-brand hover:underline disabled:opacity-50"
                    title={`El sistema sugiere ${f.sugerido}`}
                  >
                    volver a {f.sugerido}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="award"
          title="Puntaje de órdenes"
          subtitle="Cuánto vale cada tipo de orden, de 1 a 5. Al cerrarla, el sistema le abona esos puntos al técnico — nadie califica a nadie a mano."
        />
        <Button onClick={guardar} disabled={!pendientes || guardando}>
          <Icon name="check" size={15} />
          {guardando ? "Guardando…" : pendientes ? `Guardar ${pendientes} cambio${pendientes === 1 ? "" : "s"}` : "Sin cambios"}
        </Button>
      </div>

      {/* Lo que hay que entender antes de mover una estrella. */}
      <div className="rounded-xl border border-border-subtle bg-surface-2 p-3 text-[12px] leading-relaxed text-text-secondary">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-text-primary">
          <Icon name="info" size={14} className="text-brand" /> Cómo leer la escala
        </div>
        Son horas de trabajo, no importancia: <strong>5</strong> es una jornada con obra (instalación desde cero),{" "}
        <strong>3</strong> una visita normal y <strong>1</strong> un trámite que se hace desde la oficina.
        {" "}Un cambio vale desde el <strong>siguiente cierre</strong>: lo que ya se le abonó a un técnico no se
        reescribe, para que ajustar la tabla no le mueva el rendimiento del mes pasado a nadie.
      </div>

      <Input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar un tipo de orden…"
        className="max-w-sm"
      />

      {!cat ? (
        <p className="text-[13px] text-text-tertiary">Cargando…</p>
      ) : !filas.length ? (
        <p className="text-[13px] text-text-tertiary">Ningún tipo de orden coincide con «{busca}».</p>
      ) : (
        <div className="space-y-5">
          <Grupo
            titulo="Trabajo de campo"
            nota="Los que puntúan en el tablero de rendimiento de técnicos."
            filas={campo}
          />
          <Grupo
            titulo="Otros tipos"
            nota="Cortes, reconexiones y trámites. Se guarda el puntaje en la orden, pero el tablero no los mide: los ejecuta el sistema y no miden a nadie."
            filas={otros}
          />
        </div>
      )}
    </div>
  );
}
