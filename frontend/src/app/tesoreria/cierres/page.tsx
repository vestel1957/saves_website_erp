"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { PagedTable } from "@/components/ui/PagedTable";
import { Field, Input, Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  esCajera,
  type CashCloseList,
  type CashAccountOpt,
  type InformeCierreData,
  type MiCaja,
} from "@/lib/treasury";
import { CierreArqueo, type CierreDetalle } from "@/components/treasury/CierreArqueo";
import { CerrarCajaBoton } from "@/components/treasury/CerrarCajaBoton";
import { TabStrip } from "@/components/ui/TabStrip";

/** Sede que agrupa a los bancos (legacy `accounts.sede = 0`). */
const SEDE_BANCO = 0;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fechaCorta = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short" }) : "—";

const InformeCierre = dynamic(
  () => import("@/components/treasury/InformeCierre").then((m) => m.InformeCierre),
  { ssr: false },
);
/**
 * Cierre de caja. La pantalla es distinta según quién entre:
 *
 * · Cajera → el ARQUEO de su caja: cómo se compone el efectivo y los movimientos
 *   que lo forman. El informe con las cifras del día se le muestra en su panel
 *   (/dashboard), así que aquí ya no se repite.
 * · Los demás → el informe completo de cualquier caja, como siempre.
 */
export default function CierresPage() {
  const { loading: authLoading, user } = useAuth();
  if (authLoading) return <PageSkeleton />;
  return esCajera(user) ? <ArqueoDeMiCaja /> : <CierresAdmin />;
}

/* ───────────────────────── Cajera: solo su arqueo ───────────────────────── */

/**
 * Lo que la cajera necesita de esta pantalla: qué movimientos pasaron por su caja ese
 * día y cuánto efectivo debería tener en el cajón. Es el mismo arqueo que antes estaba
 * escondido detrás del botón "Detalle".
 *
 * Va contra `cash-close/preview`, no contra `cash-closes/:id`: sirve igual para un día
 * ya cerrado que para el de hoy, que es el que va a mirar el 90% de las veces.
 */
function ArqueoDeMiCaja() {
  const { authFetch } = useAuth();
  const [mi, setMi] = useState<MiCaja | null>(null);
  const [fecha, setFecha] = useState(iso(new Date()));
  const [d, setD] = useState<CierreDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    void authFetch("/treasury/mi-caja")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: MiCaja | null) => {
        setMi(m);
        if (!m?.caja) setCargando(false);
      })
      .catch(() => { setErr("No se pudo saber cuál es tu caja."); setCargando(false); });
  }, [authFetch]);

  const cajaId = mi?.caja?.id ?? null;

  const cargar = useCallback(async () => {
    if (cajaId == null) return;
    setCargando(true);
    setErr("");
    try {
      const r = await authFetch(`/treasury/cash-close/preview?cashAccountId=${cajaId}&date=${fecha}`);
      if (!r.ok) {
        setD(null);
        setErr(r.status === 403 ? "No tienes acceso a esta caja." : "No se pudo cargar el arqueo.");
        return;
      }
      setD(await r.json());
    } catch {
      setErr("No se pudo cargar el arqueo.");
    } finally {
      setCargando(false);
    }
  }, [authFetch, cajaId, fecha]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function openPdf(id: string) {
    const res = await authFetch(`/treasury/cash-closes/${id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (mi && !mi.caja) {
    return (
      <>
        <PageHeading icon="lock" title="Cierre de caja" subtitle="Tus movimientos y el efectivo del cajón" />
        <div className="rounded-xl border border-dashed border-border-default bg-surface px-4 py-16 text-center">
          <Icon name="wallet" size={22} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-sm text-text-secondary">No tienes una caja asignada.</p>
          <p className="mt-1 text-[12px] text-text-tertiary">Pídele a administración que te asigne la tuya.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <PageHeading
          icon="lock"
          title="Cierre de caja"
          subtitle={mi?.caja ? `${mi.caja.name} · tus movimientos del día` : "Tus movimientos del día"}
        />
        <div className="flex items-end gap-2">
          <Field label="Día">
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Field>
          {fecha !== iso(new Date()) && (
            <button
              onClick={() => setFecha(iso(new Date()))}
              className="mb-[1px] rounded-md border border-border-default px-2.5 py-2 text-[12px] text-text-secondary hover:bg-surface-2"
            >
              Hoy
            </button>
          )}
          {d?.id && (
            <button
              onClick={() => void openPdf(d.id!)}
              className="mb-[1px] inline-flex items-center gap-1 rounded-md border border-border-default px-2.5 py-2 text-[12px] text-text-secondary hover:bg-surface-2"
            >
              <Icon name="file-text" size={13} /> PDF
            </button>
          )}
          {/* La cajera cierra SU caja desde aquí: es la pantalla donde ya está mirando el
              arqueo con el que va a cuadrar el cajón. */}
          {d && !d.yaCerrado && mi?.caja && (
            <div className="mb-[1px]">
              <CerrarCajaBoton
                cashAccountId={mi.caja.id}
                caja={mi.caja.name}
                fecha={fecha}
                excedente={d.efectivo}
                proximoDiaHabil={d.proximoDiaHabil}
                sinActividad={d.sinActividad}
                onCerrado={() => void cargar()}
              />
            </div>
          )}
        </div>
      </div>

      {err && <div className="mb-3 rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>}

      {cargando && !d ? <PageSkeleton /> : d ? (
        <div className="flex flex-col gap-4">
          <CierreArqueo
            d={d}
            maxMovimientos="max-h-[34rem]"
          />
          <p className="text-[12px] text-text-tertiary">
            Las cifras del día (cobranza, formas de pago, servicios) están en{" "}
            <Link href="/dashboard" className="text-brand hover:underline">tu panel</Link>.
          </p>
        </div>
      ) : null}
    </>
  );
}

/* ──────────────── Administración: el informe de cualquier caja ──────────────── */

/** Un día ± n, en el mismo formato `YYYY-MM-DD` que come el backend. */
const masDias = (f: string, n: number) => {
  const [y, m, d] = f.split("-").map(Number);
  return iso(new Date(y, m - 1, d + n));
};

/**
 * Mismo alcance que el legacy (`reports/cierre`): un arqueo es de UNA caja y UN día. Lo
 * que cambió es cómo se llega hasta él.
 *
 * Antes: un formulario de Sede + Caja + Fecha y un botón "Ver"; hasta que no se pulsaba,
 * abajo no había nada, y para mirar el día anterior había que volver al formulario y
 * pulsar otra vez. Ahora la caja y el día son una barra de contexto: en cuanto hay caja
 * elegida se carga solo, las flechas ‹ › recorren días y el estado del cierre —abierto,
 * cerrado, descuadrado— es un chip visible en vez de un renglón gris.
 *
 * DOS VISTAS de lo mismo (pestañas), porque son dos preguntas distintas:
 *  · **Informe**: las cifras del día (cobranza, formas de pago, servicios) — lo que se
 *    concilia con el legacy y sale en el PDF.
 *  · **Arqueo**: exactamente lo que ve la cajera en SU pantalla — de qué se compone el
 *    efectivo del cajón y los movimientos uno a uno, con los cortes Entró / Salió.
 *    Antes esto sólo se alcanzaba desde un modal y SÓLO en días ya cerrados: el día en
 *    curso, que es el que más se mira, no había forma de verlo así.
 */
function CierresAdmin() {
  const { authFetch } = useAuth();
  const [accounts, setAccounts] = useState<CashAccountOpt[]>([]);

  const [sede, setSede] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [fecha, setFecha] = useState(iso(new Date()));

  const [informe, setInforme] = useState<InformeCierreData | null>(null);
  const [historial, setHistorial] = useState<CashCloseList | null>(null);
  const [cargando, setCargando] = useState(false);
  const [err, setErr] = useState("");
  /** Qué pestaña se está mirando: las cifras del día o el arqueo de la cajera. */
  const [vista, setVista] = useState<"informe" | "arqueo">("informe");
  /** El arqueo (vista de la cajera). Se pide sólo cuando se abre su pestaña. */
  const [arqueo, setArqueo] = useState<CierreDetalle | null>(null);
  const [cargandoArqueo, setCargandoArqueo] = useState(false);
  /** Se incrementa al cerrar la caja, para que el informe se vuelva a pedir. */
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    void authFetch("/treasury/cash-accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((accs) => setAccounts(accs ?? []))
      .catch(() => {});
  }, [authFetch]);

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

  /**
   * La única caja que ve el usuario, si sólo ve una. `/treasury/cash-accounts` ya
   * viene acotado por `caja-scope.ts`, así que a la cajera le llega su caja y nada
   * más: elegirla a mano es un paso vacío, se selecciona sola.
   */
  const unicaCaja = cajas.length === 1 ? cajas[0] : null;
  useEffect(() => {
    if (!unicaCaja) return;
    setSede(String(unicaCaja.branchLegacy ?? ""));
    setCashAccountId(String(unicaCaja.id));
  }, [unicaCaja]);

  // Se carga solo: la caja y el día son el estado de la pantalla, no un formulario que
  // haya que enviar. `cashAccountId` vacío = todavía no hay nada que pedir.
  useEffect(() => {
    if (!cashAccountId || !fecha) { setInforme(null); return; }
    let vivo = true;
    setCargando(true);
    setErr("");
    void (async () => {
      try {
        const [rInf, rHist] = await Promise.all([
          authFetch(`/treasury/cash-close/report?cashAccountId=${cashAccountId}&date=${fecha}`),
          authFetch(`/treasury/cash-closes?cashAccountId=${cashAccountId}&all=1&page=1&pageSize=10`),
        ]);
        if (!vivo) return;
        if (!rInf.ok) {
          setInforme(null);
          setErr(rInf.status === 403 ? "No tienes acceso a esta caja." : "No se pudo cargar el informe.");
          return;
        }
        setInforme(await rInf.json());
        setHistorial(rHist.ok ? await rHist.json() : null);
      } catch {
        if (vivo) setErr("No se pudo cargar el informe.");
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [authFetch, cashAccountId, fecha, recarga]);

  /**
   * El arqueo (pestaña "Como lo ve la cajera"). Se pide APARTE y sólo cuando se abre esa
   * pestaña: es otra consulta al servidor y la mayoría de las visitas se quedan en el
   * informe. Va contra `cash-close/preview`, igual que la pantalla de la cajera, que
   * sirve tanto para un día cerrado como para el que está en curso.
   */
  useEffect(() => { setArqueo(null); }, [cashAccountId, fecha, recarga]);
  useEffect(() => {
    if (vista !== "arqueo" || !cashAccountId || !fecha || arqueo) return;
    let vivo = true;
    setCargandoArqueo(true);
    void (async () => {
      try {
        const r = await authFetch(`/treasury/cash-close/preview?cashAccountId=${cashAccountId}&date=${fecha}`);
        if (!vivo) return;
        if (!r.ok) {
          setErr(r.status === 403 ? "No tienes acceso a esta caja." : "No se pudo cargar el arqueo.");
          return;
        }
        setArqueo(await r.json());
      } catch {
        if (vivo) setErr("No se pudo cargar el arqueo.");
      } finally {
        if (vivo) setCargandoArqueo(false);
      }
    })();
    return () => { vivo = false; };
  }, [authFetch, vista, cashAccountId, fecha, arqueo]);

  async function openPdf(id: string) {
    const res = await authFetch(`/treasury/cash-closes/${id}/pdf`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const cajaSel = cajas.find((c) => String(c.id) === cashAccountId) ?? null;
  const hoy = iso(new Date());
  const a = informe?.arqueo;

  return (
    <>
      <div className="mb-4">
        <PageHeading icon="lock" title="Cierre de caja" subtitle="El arqueo de una caja y un día" />
      </div>

      {/* ── La barra de contexto: qué caja y qué día se está mirando ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-surface p-3 shadow-sm">
        {/* Cerrar es LA acción de esta pantalla, así que abre la barra. Sólo aparece si el
            día sigue abierto: un día cerrado no se vuelve a cerrar. */}
        {a && !a.yaCerrado && cajaSel && (
          <CerrarCajaBoton
            cashAccountId={Number(cashAccountId)}
            caja={cajaSel.name}
            fecha={fecha}
            excedente={a.excedente}
            proximoDiaHabil={a.proximoDiaHabil}
            sinActividad={a.sinActividad}
            onCerrado={() => setRecarga((n) => n + 1)}
          />
        )}

        {/* Recorrer días es lo que más se hace aquí, y antes costaba volver al formulario. */}
        <div className="flex items-center overflow-hidden rounded-lg border border-border-default bg-surface">
          <button
            onClick={() => setFecha((f) => masDias(f, -1))}
            aria-label="Día anterior"
            className="px-2 py-1.5 text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            <Icon name="chevron-left" size={15} />
          </button>
          <input
            type="date"
            value={fecha}
            onChange={(e) => e.target.value && setFecha(e.target.value)}
            aria-label="Fecha"
            className="border-x border-border-default bg-transparent px-2 py-1.5 text-[13px] font-semibold text-text-primary focus:outline-none"
          />
          <button
            onClick={() => setFecha((f) => masDias(f, 1))}
            disabled={fecha >= hoy}
            aria-label="Día siguiente"
            className="px-2 py-1.5 text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Icon name="chevron-right" size={15} />
          </button>
        </div>
        {fecha !== hoy && (
          <button
            onClick={() => setFecha(hoy)}
            className="rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2"
          >
            Hoy
          </button>
        )}

        {/* Con una sola caja a la vista (la cajera) no hay nada que elegir: se pinta
            de qué caja es el arqueo y se quitan los dos desplegables. */}
        {unicaCaja ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-default px-2.5 py-1.5 text-[13px] font-semibold text-text-primary">
            <Icon name="landmark" size={14} className="text-text-tertiary" />
            {unicaCaja.sede ? `${unicaCaja.sede} · ` : ""}{unicaCaja.name}
          </span>
        ) : (
          <>
            <Select
              value={sede}
              aria-label="Sede"
              className="w-auto min-w-[9rem]"
              onChange={(e) => { setSede(e.target.value); setCashAccountId(""); }}
            >
              <option value="">— Sede —</option>
              {sedes.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
            </Select>

            <Select
              value={cashAccountId}
              aria-label="Caja"
              disabled={!sede}
              className="w-auto min-w-[10rem]"
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              <option value="">{sede ? "— Caja —" : "— Elige primero la sede —"}</option>
              {cajasDeLaSede.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </>
        )}

        {/* El estado del cierre deja de ser un renglón gris debajo del informe. */}
        {a && (
          a.yaCerrado ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[12px] font-semibold text-success-text">
              <Icon name="check" size={12} /> Cerrada · se barrieron {cop(a.excedente)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-[12px] font-semibold text-warning-text">
              <Icon name="clock" size={12} /> Sin cerrar · el cajón tiene {cop(a.excedente)}
            </span>
          )
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* El PDF es el del cierre firmado: sólo existe si el día ya se cerró. Los
              movimientos ya no viven en un modal — son la otra pestaña. */}
          {a?.id && (
            <button onClick={() => void openPdf(a.id!)} className="inline-flex items-center gap-1 rounded-lg border border-border-default px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2">
              <Icon name="file-text" size={13} /> PDF
            </button>
          )}
        </div>
      </div>

      {err && <div className="mb-3 rounded-lg bg-error-soft px-3 py-2 text-sm text-error-text">{err}</div>}

      {/* ── Las dos formas de mirar el mismo día ── */}
      {!!cashAccountId && (
        <TabStrip
          tabs={[
            { key: "informe", label: "Informe del día", icon: "bar-chart-3" },
            { key: "arqueo", label: "Arqueo y movimientos", icon: "wallet", count: arqueo?.movimientos.length },
          ]}
          active={vista}
          onChange={setVista}
        />
      )}

      {/* ── El resultado ── */}
      {!cashAccountId ? (
        <div className="rounded-xl border border-dashed border-border-default bg-surface px-4 py-16 text-center">
          <Icon name="wallet" size={22} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-sm text-text-secondary">Elige una sede y una caja arriba.</p>
          <p className="mt-1 text-[12px] text-text-tertiary">El informe se carga solo; las flechas recorren los días.</p>
        </div>
      ) : vista === "arqueo" ? (
        cargandoArqueo && !arqueo ? <PageSkeleton /> : arqueo ? (
          <div className="flex flex-col gap-4">
            {/* Lo mismo que ve la cajera en su pantalla: de qué se compone el efectivo del
                cajón y los movimientos uno a uno, con los cortes Entró / Salió. */}
            <CierreArqueo d={arqueo} maxMovimientos="max-h-[34rem]" />
            <p className="text-[12px] text-text-tertiary">
              Esto es lo que ve la cajera de {cajaSel?.name ?? "esta caja"} en su pantalla de cierre.
              Las cifras del día (cobranza, formas de pago, servicios) están en la pestaña{" "}
              <button onClick={() => setVista("informe")} className="font-semibold text-brand hover:underline">Informe del día</button>.
            </p>
          </div>
        ) : null
      ) : cargando && !informe ? (
        <PageSkeleton />
      ) : informe ? (
        <div className="flex flex-col gap-6">
          <InformeCierre d={informe} />

          {a && (
            <p className="text-[12px] text-text-tertiary">
              {a.yaCerrado
                ? <>El excedente se arrastró al <strong className="text-text-secondary">{fechaCorta(a.proximoDiaHabil)}</strong>. El detalle movimiento a movimiento está en <button onClick={() => setVista("arqueo")} className="font-semibold text-brand hover:underline">Arqueo y movimientos</button>.</>
                : <>Cuando se cierre, el efectivo se arrastrará al <strong className="text-text-secondary">{fechaCorta(a.proximoDiaHabil)}</strong> (próximo día hábil; el sábado también lo es). Los movimientos, uno a uno, están en <button onClick={() => setVista("arqueo")} className="font-semibold text-brand hover:underline">Arqueo y movimientos</button>.</>}
            </p>
          )}

          {/* Los últimos cierres de esta caja, para saltar a otro día sin salir de aquí */}
          {!!historial?.items?.length && (
            <section className="shrink-0">
              <h3 className="mb-1 text-[13px] font-semibold text-text-primary">
                Últimos cierres de {cajaSel?.name ?? "esta caja"}
              </h3>
              <PagedTable
                rows={historial.items}
                empty="Esta caja no tiene cierres."
                columns={[
                  { key: "date", header: "Fecha", render: (r) => (r.date ? new Date(r.date).toLocaleDateString("es-CO", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "—") },
                  { key: "cajero", header: "Cajero", render: (r) => <span className="text-text-secondary">{r.cajero ?? "—"}</span> },
                  { key: "sur", header: "Excedente barrido", align: "right", render: (r) => <span className="font-semibold">{cop(r.surplus)}</span> },
                  { key: "habil", header: "Arrastra a", render: (r) => <span className="text-text-tertiary">{fechaCorta(r.proximoDiaHabil)}</span> },
                  { key: "acciones", header: "", align: "right", render: (r) => (
                    <button
                      onClick={() => setFecha(String(r.date).slice(0, 10))}
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
    </>
  );
}
