"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import type { OltRow, TrafficTable } from "@/lib/olt";
import { BotonOrden, useTablaOrdenable } from "@/components/ui/tabla-ordenable";

/**
 * Velocidad en OLT por plan: la tabla que traduce "300 Megas ST" a las dos
 * traffic-tables que se le meten al service-port al autenticar.
 *
 * El índice NO se deduce de las megas —los TID no siguen ninguna serie— así que
 * hay dos ayudas: las tablas del equipo cuyo techo (PIR) coincide con las megas
 * del plan, y sobre todo **Deducir de la planta**, que mira con qué velocidad
 * están funcionando de verdad los abonados de cada plan.
 *
 * Nombres de las columnas: `inbound` (RX en `display service-port`) es la
 * BAJADA del abonado y `outbound` (TX) la SUBIDA. Suena al revés, pero está
 * comprobado sobre 1.551 service-ports de la planta, donde RX ≥ TX en el 99,9%.
 *
 * El mapeo es POR OLT: los TID cambian de equipo a equipo.
 */

type Fila = {
  id: string;
  name: string;
  active: boolean;
  subscribers: number;
  megas: number | null;
  megasDelNombre: boolean;
  propia: { trafficIn: number | null; trafficOut: number | null } | null;
  base: { trafficIn: number | null; trafficOut: number | null } | null;
  candidatas: { id: number; mbps: number | null }[];
};
type Tablero = { items: Fila[]; tablas: TrafficTable[]; sinMapear: number; oltId: string | null };

type ParObservado = {
  trafficIn: number; trafficOut: number; veces: number;
  mbpsBajada: number | null; mbpsSubida: number | null; acorde: boolean;
};
type Propuesta = {
  planId: string; name: string; megas: number | null;
  muestras: number; respaldo: number; confianza: number; desalineados: number;
  trafficIn: number | null; trafficOut: number | null;
  mbpsBajada: number | null; mbpsSubida: number | null;
  sinPropuesta: string | null;
  observado: ParObservado[];
  difiereDeLoGuardado: boolean;
};
type Deduccion = {
  ok: boolean; error: string; propuestas: Propuesta[];
  puertos: number; onus: number; sinServicePort: number; desalineados: number;
};

const val = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const mb = (n: number | null | undefined) => (n == null ? "?" : n.toLocaleString("es-CO"));

export function VelocidadOltPlanes() {
  const { authFetch } = useAuth();
  const [olts, setOlts] = useState<OltRow[]>([]);
  const [oltId, setOltId] = useState("");
  const [data, setData] = useState<Tablero | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState<string | null>(null);
  /** Ediciones sin guardar, por plan. */
  const [draft, setDraft] = useState<Record<string, { in: string; out: string }>>({});
  const [soloUsados, setSoloUsados] = useState(true);
  const [ded, setDed] = useState<Deduccion | null>(null);
  const [deduciendo, setDeduciendo] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  useEffect(() => {
    void authFetch("/network/olt/olts")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: OltRow[]) => {
        setOlts(rows);
        setOltId((prev) => prev || rows[0]?.id || "");
      })
      .catch(() => setOlts([]));
  }, [authFetch]);

  const cargar = useCallback(async () => {
    if (!oltId) return;
    setCargando(true);
    try {
      const r = await authFetch(`/network/olt/plan-profiles?oltId=${oltId}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo cargar");
      setData(d);
      setDraft({});
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
      setData(null);
    } finally {
      setCargando(false);
    }
  }, [authFetch, oltId]);

  useEffect(() => { void cargar(); setDed(null); }, [cargar]);

  /**
   * Lee la planta: por cada plan, con qué par de traffic-tables están sus
   * abonados. Es lento (un comando SSH por puerto PON con abonados), por eso va
   * en un botón y no al abrir la pestaña.
   */
  async function deducir() {
    setDeduciendo(true);
    try {
      const r = await authFetch(`/network/olt/plan-profiles/deducir?oltId=${oltId}`);
      const d: Deduccion = await r.json();
      if (!r.ok) throw new Error((d as any)?.message || "No se pudo deducir");
      setDed(d);
      if (!d.ok) toast(d.error, "alert-triangle");
      else toast(`Leídos ${d.onus} abonados en ${d.puertos} puertos`, "check");
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setDeduciendo(false);
    }
  }

  const propuestaDe = (planId: string) => ded?.propuestas.find((p) => p.planId === planId) ?? null;
  /** Propuestas con valores y que aún no están guardadas tal cual. */
  const aplicables = (ded?.propuestas ?? []).filter((p) => {
    if (p.trafficIn == null || p.trafficOut == null) return false;
    const fila = data?.items.find((f) => f.id === p.planId);
    return fila?.propia?.trafficIn !== p.trafficIn || fila?.propia?.trafficOut !== p.trafficOut;
  });

  async function aplicarTodas() {
    setAplicando(true);
    try {
      const r = await authFetch(`/network/olt/plan-profiles/lote`, {
        method: "POST",
        body: JSON.stringify({
          oltId,
          filas: aplicables.map((p) => ({ planId: p.planId, trafficIn: p.trafficIn, trafficOut: p.trafficOut })),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message || "No se pudo guardar");
      toast(`${j.guardadas} plan(es) configurados`, "check");
      await cargar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setAplicando(false);
    }
  }

  function editar(planId: string, campo: "in" | "out", valor: string, fila: Fila) {
    setDraft((d) => {
      const actual = d[planId] ?? { in: val(fila.propia?.trafficIn), out: val(fila.propia?.trafficOut) };
      return { ...d, [planId]: { ...actual, [campo]: valor } };
    });
  }

  async function guardar(fila: Fila) {
    const d = draft[fila.id];
    if (!d) return;
    setGuardando(fila.id);
    try {
      const r = await authFetch(`/network/olt/plan-profiles`, {
        method: "POST",
        body: JSON.stringify({
          planId: fila.id, oltId,
          trafficIn: d.in === "" ? null : Number(d.in),
          trafficOut: d.out === "" ? null : Number(d.out),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.message || "No se pudo guardar");
      toast(`Velocidad guardada para "${fila.name}"`, "check");
      await cargar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setGuardando(null);
    }
  }

  const tablas = data?.tablas ?? [];
  const filas = (data?.items ?? []).filter((f) => (soloUsados ? f.subscribers > 0 || f.propia : true));

  // La velocidad se guarda como valor del traffic-table (ver memoria del OLT):
  // se ordena por ese número, que es lo que hay, no por la etiqueta.
  const t = useTablaOrdenable(filas, {
    plan: (f) => f.name,
    abonados: (f) => f.subscribers,
    bajada: (f) => f.propia?.trafficIn,
    subida: (f) => f.propia?.trafficOut,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border-subtle bg-surface-2 p-3 text-[12.5px] leading-relaxed text-text-secondary">
        Aquí se decide <b>qué velocidad recibe cada plan en la OLT</b>. Con esto configurado, el técnico
        ya no elige megas al autenticar una ONU desde la orden de instalación: se aplican solas según el
        plan del abonado. Un plan sin velocidad configurada <b>no se puede autenticar</b> — es preferible
        a dejar la ONU sin tope.
        <br />
        Lo más rápido es <b>Deducir de la planta</b>: lee con qué velocidad están funcionando ya los
        abonados de cada plan y propone esa. Se guarda por OLT, porque los índices cambian de un equipo a otro.
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-[12px] text-text-secondary">
          OLT
          <Select value={oltId} onChange={(e) => setOltId(e.target.value)} className="mt-0.5 w-56">
            {olts.map((o) => <option key={o.id} value={o.id}>{o.name}{o.branch ? ` · ${o.branch}` : ""}</option>)}
          </Select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {data && data.sinMapear > 0 && (
            <Badge tone="warning" label={`${data.sinMapear} plan(es) con abonados sin velocidad`} />
          )}
          <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
            <input type="checkbox" checked={soloUsados} onChange={(e) => setSoloUsados(e.target.checked)} />
            Solo planes en uso
          </label>
          <Button size="sm" disabled={deduciendo || !oltId} onClick={() => void deducir()}>
            <Icon name="wand-sparkles" size={13} /> {deduciendo ? "Leyendo la planta…" : "Deducir de la planta"}
          </Button>
          <Button variant="secondary" size="sm" disabled={cargando} onClick={() => void cargar()}>
            <Icon name="refresh-cw" size={13} /> {cargando ? "Leyendo la OLT…" : "Refrescar"}
          </Button>
        </div>
      </div>

      {deduciendo && (
        <p className="text-[12.5px] text-text-tertiary">
          Recorriendo los puertos PON de la OLT por SSH para ver la configuración real de cada abonado.
          Tarda cerca de medio minuto.
        </p>
      )}

      {/* Resultado de la deducción: lo que se leyó y lo que se puede aplicar. */}
      {ded?.ok && (
        <div className="rounded-xl border border-border-subtle bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] text-text-secondary">
              Leídos <b>{ded.onus}</b> abonados en <b>{ded.puertos}</b> puertos.
              {" "}<b className={ded.desalineados > 0 ? "text-warning-text" : ""}>{ded.desalineados}</b> están
              con una velocidad que <b>no corresponde a su plan</b>.
            </p>
            {!!aplicables.length && (
              <Button size="sm" disabled={aplicando} onClick={() => void aplicarTodas()}>
                <Icon name="check" size={13} /> {aplicando ? "Guardando…" : `Aplicar ${aplicables.length} propuesta(s)`}
              </Button>
            )}
          </div>
          {!aplicables.length && (
            <p className="mt-1 text-[11.5px] text-text-tertiary">
              No hay propuestas nuevas que aplicar: o ya están guardadas, o ningún abonado tiene hoy la
              velocidad que le corresponde y hay que elegirla a mano.
            </p>
          )}
        </div>
      )}

      {cargando && !data && <p className="text-[13px] text-text-tertiary">Leyendo las tablas de tráfico de la OLT por SSH…</p>}

      {data && !tablas.length && (
        <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
          No se pudieron leer las tablas de tráfico de esta OLT, así que no hay velocidades que elegir.
          Compruebe la conexión SSH del equipo en Red › OLT y refresque.
        </p>
      )}

      {data && !!tablas.length && (
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full min-w-[820px] text-[12.5px]">
            <thead>
              <tr className="border-b border-border-subtle bg-surface-2 text-left text-text-tertiary">
                <th className="px-3 py-2 font-semibold"><BotonOrden t={t} clave="plan">Plan</BotonOrden></th>
                <th className="px-3 py-2 text-right font-semibold"><BotonOrden t={t} clave="abonados">Abonados</BotonOrden></th>
                <th className="px-3 py-2 font-semibold"><BotonOrden t={t} clave="bajada">Bajada (RX)</BotonOrden></th>
                <th className="px-3 py-2 font-semibold"><BotonOrden t={t} clave="subida">Subida (TX)</BotonOrden></th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {t.filas.map((f) => {
                const d = draft[f.id];
                // Bajada = `inbound` (columna RX) · Subida = `outbound` (columna TX).
                const vBajada = d ? d.in : val(f.propia?.trafficIn);
                const vSubida = d ? d.out : val(f.propia?.trafficOut);
                const sucio = !!d && (d.in !== val(f.propia?.trafficIn) || d.out !== val(f.propia?.trafficOut));
                const mapeado = f.propia?.trafficIn != null || f.propia?.trafficOut != null;
                const p = propuestaDe(f.id);
                return (
                  <tr key={f.id} className="border-b border-border-subtle align-top last:border-0">
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-text-primary">{f.name}</span>
                        {!f.active && <Badge tone="warning" label="Oculto" />}
                        {mapeado
                          ? <Badge tone="success" label="Configurado" />
                          : f.subscribers > 0 && <Badge tone="warning" label="Sin velocidad" />}
                        {!!p?.desalineados && (
                          <Badge tone="warning" label={`${p.desalineados} abonado(s) con otra velocidad`} />
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-text-tertiary">
                        {f.megas != null && <span>{f.megas} Mbps{f.megasDelNombre ? " (leído del nombre)" : ""}</span>}
                        {f.base && (f.base.trafficIn != null || f.base.trafficOut != null) && (
                          <span>por defecto: bajada {f.base.trafficIn ?? "—"} / subida {f.base.trafficOut ?? "—"}</span>
                        )}
                      </div>
                      {p && <EvidenciaPlanta p={p} onUsar={() => setDraft((x) => ({ ...x, [f.id]: { in: val(p.trafficIn), out: val(p.trafficOut) } }))} />}
                    </td>
                    <td className="px-3 py-2 text-right text-text-secondary">{f.subscribers}</td>
                    <td className="px-3 py-2">
                      <SelectorTabla value={vBajada} tablas={tablas} candidatas={f.candidatas} onChange={(v) => editar(f.id, "in", v, f)} />
                    </td>
                    <td className="px-3 py-2">
                      <SelectorTabla value={vSubida} tablas={tablas} candidatas={f.candidatas} onChange={(v) => editar(f.id, "out", v, f)} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {sucio && (
                        <Button size="sm" disabled={guardando === f.id} onClick={() => void guardar(f)}>
                          {guardando === f.id ? "Guardando…" : "Guardar"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!filas.length && (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-[12.5px] text-text-tertiary">No hay planes que mostrar.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11.5px] text-text-tertiary">
        Las <b>sugeridas</b> de cada desplegable son las tablas cuyo techo (PIR) coincide con las megas del
        plan. Ojo con los nombres del equipo: lo que la OLT llama <span className="font-mono">inbound</span>/RX
        es la <b>bajada</b> del abonado y <span className="font-mono">outbound</span>/TX la <b>subida</b>.
      </p>
    </div>
  );
}

/**
 * Lo que dice la planta sobre este plan. Se enseña entero —incluido lo
 * descartado— porque el operador tiene que poder ver que la mayoría de sus
 * abonados están mal antes de fiarse de una propuesta minoritaria.
 */
function EvidenciaPlanta({ p, onUsar }: { p: Propuesta; onUsar: () => void }) {
  return (
    <div className="mt-1.5 rounded-lg border border-border-subtle bg-surface-2 p-2 text-[11.5px]">
      {p.sinPropuesta ? (
        <p className="text-warning-text">{p.sinPropuesta}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-secondary">
            Planta: <b className="text-text-primary">{p.respaldo}</b> de {p.muestras} abonado(s) con{" "}
            <b>{mb(p.mbpsBajada)} ↓ / {mb(p.mbpsSubida)} ↑ Mbps</b>{" "}
            <span className="font-mono text-text-tertiary">(tt {p.trafficIn}/{p.trafficOut})</span>
          </span>
          <button type="button" onClick={onUsar} className="rounded border border-brand px-1.5 py-0.5 font-semibold text-brand hover:bg-brand/10">
            Usar
          </button>
        </div>
      )}
      {p.observado.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-text-tertiary">
          {p.observado.map((o, i) => (
            <span key={i} className={o.acorde ? "text-success-text" : ""}>
              {o.acorde ? "✓" : "✗"} {mb(o.mbpsBajada)}/{mb(o.mbpsSubida)} × {o.veces}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Desplegable de traffic-tables con las candidatas del plan arriba del todo. */
function SelectorTabla({
  value, tablas, candidatas, onChange,
}: {
  value: string;
  tablas: TrafficTable[];
  candidatas: { id: number; mbps: number | null }[];
  onChange: (v: string) => void;
}) {
  const ids = new Set(candidatas.map((c) => c.id));
  const etiqueta = (t: TrafficTable) => `${t.id} · ${t.mbps != null ? `${t.mbps.toLocaleString("es-CO")} Mbps` : "sin límite"}`;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full min-w-[170px]">
      <option value="">— Sin configurar —</option>
      {!!candidatas.length && (
        <optgroup label="Sugeridas por las megas del plan">
          {tablas.filter((t) => ids.has(Number(t.id))).map((t) => <option key={`s${t.id}`} value={t.id}>{etiqueta(t)}</option>)}
        </optgroup>
      )}
      <optgroup label="Todas las tablas de la OLT">
        {tablas.map((t) => <option key={t.id} value={t.id}>{etiqueta(t)}</option>)}
      </optgroup>
    </Select>
  );
}
