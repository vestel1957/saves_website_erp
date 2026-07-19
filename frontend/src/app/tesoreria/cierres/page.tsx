"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  type CashCloseList,
  type CashAccountOpt,
  type InformeCierreData,
  type MiCaja,
} from "@/lib/treasury";

/** Sede que agrupa a los bancos (legacy `accounts.sede = 0`). */
const SEDE_BANCO = 0;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fechaCorta = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" }) : "—";

const InformeCierre = dynamic(
  () => import("@/components/treasury/InformeCierre").then((m) => m.InformeCierre),
  { ssr: false },
);
const CierreDetalleModal = dynamic(
  () => import("@/components/treasury/CierreDetalleModal").then((m) => m.CierreDetalleModal),
  { ssr: false },
);

/** Lo que se está mirando ahora mismo. null = todavía no se ha pulsado Ver. */
type Consulta = { cashAccountId: string; fecha: string };

/**
 * Cierre de caja — mismo flujo que el legacy (`reports/cierre`): un formulario de
 * Sede + Caja + Fecha y un botón Ver; **hasta que no se pulsa, no se muestra nada**.
 *
 * Un arqueo es de UNA caja y UN día. A la cajera se le fijan sede y caja (sólo elige
 * fecha), igual que hace `acc_list()` allá; el backend además lo exige con un 403, así
 * que esto es comodidad, no la barrera de seguridad.
 */
export default function CierresPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccountOpt[]>([]);
  const [mi, setMi] = useState<MiCaja | null>(null);

  // --- El formulario (todavía no se ha consultado nada) ---
  const [sede, setSede] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [fecha, setFecha] = useState(iso(new Date()));

  // --- Lo consultado ---
  const [consulta, setConsulta] = useState<Consulta | null>(null);
  const [informe, setInforme] = useState<InformeCierreData | null>(null);
  const [historial, setHistorial] = useState<CashCloseList | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState("");
  const [detalleId, setDetalleId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void Promise.all([
      authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])),
      authFetch("/treasury/mi-caja").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([accs, miCaja]) => { setAccounts(accs ?? []); setMi(miCaja); })
      .catch(() => {});
  }, [authLoading, authFetch]);

  /** Sólo cajas de sede: un banco no se cierra, se consolida DENTRO del cierre. */
  const cajas = useMemo(() => accounts.filter((a) => a.branchLegacy !== SEDE_BANCO), [accounts]);

  const sedes = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cajas) {
      if (c.branchLegacy == null) continue;
      m.set(String(c.branchLegacy), c.sede ?? `Sede ${c.branchLegacy}`);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [cajas]);

  const cajasDeLaSede = useMemo(
    () => (sede ? cajas.filter((c) => String(c.branchLegacy) === sede) : []),
    [cajas, sede],
  );

  // A la cajera se le fijan sede y caja: sólo elige la fecha.
  useEffect(() => {
    if (!mi?.esCajera || !mi.caja || cashAccountId) return;
    setCashAccountId(String(mi.caja.id));
    if (mi.caja.branchLegacy != null) setSede(String(mi.caja.branchLegacy));
  }, [mi, cashAccountId]);

  const puedeVer = !!cashAccountId && !!fecha;

  const consultar = useCallback(async (q: Consulta) => {
    setCargando(true);
    setErr("");
    try {
      const [rInf, rHist] = await Promise.all([
        authFetch(`/treasury/cash-close/report?cashAccountId=${q.cashAccountId}&date=${q.fecha}`),
        authFetch(`/treasury/cash-closes?cashAccountId=${q.cashAccountId}&all=1&page=1&pageSize=10`),
      ]);
      if (!rInf.ok) {
        setInforme(null);
        setErr(rInf.status === 403 ? "No tienes acceso a esta caja." : "No se pudo cargar el informe.");
        return;
      }
      setInforme(await rInf.json());
      setHistorial(rHist.ok ? await rHist.json() : null);
    } catch {
      setErr("No se pudo cargar el informe.");
    } finally {
      setCargando(false);
    }
  }, [authFetch]);

  function onVer() {
    if (!puedeVer) return;
    const q = { cashAccountId, fecha };
    setConsulta(q);
    void consultar(q);
  }

  async function openPdf(id: string) {
    const res = await authFetch(`/treasury/cash-closes/${id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (authLoading) return <PageSkeleton />;

  const cajaSel = cajas.find((c) => String(c.id) === cashAccountId) ?? null;

  return (
    <>
      <div className="mb-4">
        <PageHeading icon="lock" title="Cierre de caja" subtitle="Elige sede, caja y fecha, y pulsa Ver" />
      </div>

      {/* ── El formulario. Hasta que no se pulsa Ver, abajo no hay nada. ── */}
      <div className="mb-4 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Sede" required>
            <Select
              value={sede}
              disabled={!!mi?.esCajera}
              onChange={(e) => {
                setSede(e.target.value);
                setCashAccountId(""); // la caja depende de la sede
              }}
            >
              <option value="">— Selecciona —</option>
              {sedes.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
            </Select>
          </Field>

          {/* Sin `hint`: el hint va DEBAJO del input y haría esa columna más alta, con lo
              que el botón (alineado al fondo de la fila) quedaría por debajo de la línea
              de los inputs. Lo que decían los hints se dice en el placeholder y en el
              estado vacío. */}
          <Field label="Caja" required>
            <Select
              value={cashAccountId}
              disabled={!!mi?.esCajera || !sede}
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              <option value="">{sede || mi?.esCajera ? "— Selecciona —" : "— Elige primero la sede —"}</option>
              {cajasDeLaSede.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label="Fecha" required>
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Field>

          {/* El espaciador invisible ocupa lo que la etiqueta de los demás campos, así el
              botón queda a la misma altura que los inputs y no depende de `items-end`. */}
          <div>
            <span aria-hidden className="mb-1 block select-none text-[11px] font-semibold text-transparent">.</span>
            {/* `border border-transparent`: los inputs llevan borde y el botón primario no,
                así que sin esto queda 2px más bajo que ellos aun teniendo el mismo padding. */}
            <Button onClick={onVer} disabled={!puedeVer || cargando} className="w-full border border-transparent">
              {cargando ? "Cargando…" : "Ver"}
            </Button>
          </div>
        </div>

        {mi?.esCajera && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-text-tertiary">
            <Icon name="lock" size={12} />
            {mi.caja
              ? <>Ves solo tu caja: <strong className="text-text-secondary">{mi.caja.name}</strong>.</>
              : <>No tienes una caja asignada. Pídele a administración que te asigne la tuya.</>}
          </p>
        )}
      </div>

      {err && <div className="mb-3 rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>}

      {/* ── El resultado ── */}
      {!consulta ? (
        <div className="rounded-xl border border-dashed border-border-default bg-surface px-4 py-16 text-center">
          <Icon name="search" size={22} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-sm text-text-secondary">Elige sede, caja y fecha, y pulsa <strong>Ver</strong>.</p>
          <p className="mt-1 text-[12px] text-text-tertiary">El arqueo es de una caja y un día.</p>
        </div>
      ) : cargando && !informe ? (
        <PageSkeleton />
      ) : informe ? (
        <div className="flex flex-col gap-6">
          {/* Acciones sobre el cierre consultado */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-text-tertiary">
              {informe.arqueo.yaCerrado
                ? <>Esta caja ya se cerró ese día: se barrieron <strong className="text-text-secondary">{cop(informe.arqueo.excedente)}</strong> y se arrastraron al {fechaCorta(informe.arqueo.proximoDiaHabil)}.</>
                : <>Este día <strong className="text-text-secondary">aún no se ha cerrado</strong>. El cajón tiene {cop(informe.arqueo.excedente)}.</>}
            </span>
            {informe.arqueo.id && (
              <div className="flex gap-1">
                <button onClick={() => setDetalleId(informe.arqueo.id)} className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2">
                  <Icon name="search" size={13} /> Detalle
                </button>
                <button onClick={() => void openPdf(informe.arqueo.id!)} className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2">
                  <Icon name="file-text" size={13} /> PDF
                </button>
              </div>
            )}
          </div>

          <InformeCierre d={informe} />

          {/* Los últimos cierres de esta caja, para saltar a otro día sin salir de aquí */}
          {!!historial?.items?.length && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-text-primary">
                Últimos cierres de {cajaSel?.name ?? "esta caja"}
              </h3>
              <DataTable
                autoHeight
                rows={historial.items}
                empty="Esta caja no tiene cierres."
                columns={[
                  { key: "date", header: "Fecha", render: (r) => (r.date ? new Date(r.date).toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "—") },
                  { key: "cajero", header: "Cajero", render: (r) => <span className="text-text-secondary">{r.cajero ?? "—"}</span> },
                  { key: "sur", header: "Excedente barrido", align: "right", render: (r) => <span className="font-semibold">{cop(r.surplus)}</span> },
                  { key: "habil", header: "Arrastra a", render: (r) => <span className="text-text-tertiary">{fechaCorta(r.proximoDiaHabil)}</span> },
                  { key: "acciones", header: "", align: "right", render: (r) => (
                    <button
                      onClick={() => {
                        const f = String(r.date).slice(0, 10);
                        setFecha(f);
                        const q = { cashAccountId, fecha: f };
                        setConsulta(q);
                        void consultar(q);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-2"
                    >
                      <Icon name="search" size={13} /> Ver ese día
                    </button>
                  ) },
                ]}
              />
            </section>
          )}
        </div>
      ) : null}

      <CierreDetalleModal open={!!detalleId} closeId={detalleId} onClose={() => setDetalleId(null)} />
    </>
  );
}
