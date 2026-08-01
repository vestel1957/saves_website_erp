"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/**
 * Autenticación de la ONU DENTRO de la orden de instalación.
 *
 * Un desplegable y un botón. El técnico solo decide lo que solo él puede saber
 * —cuál de las ONUs que se están anunciando es la que acaba de instalar— y el
 * resto (OLT de la sede, puerto, VLAN, perfiles, comentario, vínculo con el
 * abonado) lo resuelve el servidor.
 *
 * La VELOCIDAD ya no se elige: sale del plan contratado. Si el plan no tiene su
 * equivalencia configurada en la OLT, el bloque no deja autenticar y dice dónde
 * arreglarlo — antes se podía dar de alta una ONU sin tope de velocidad sin que
 * nadie se enterara hasta ver el consumo.
 */

/** Tipos de orden donde este bloque tiene sentido (espejo de `modoDeOrden` en el backend). */
const TIPOS_AUTENTICAR = ["instalac", "traslado", "cambio de equipo", "reinstalac"];
const TIPOS_VELOCIDAD = ["subir megas", "bajar megas", "cambio de plan"];

export function modoDeOrden(type: string | null | undefined): "AUTENTICAR" | "VELOCIDAD" | null {
  const t = (type ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (TIPOS_VELOCIDAD.some((k) => t.includes(k))) return "VELOCIDAD";
  if (TIPOS_AUTENTICAR.some((k) => t.includes(k))) return "AUTENTICAR";
  return null;
}

type EquipoInv = { code: number; serial: string | null; bodega: string | null; status: string | null };
type Candidato = {
  sn: string; fsp: string; model: string | null; vendor: string | null; mac: string | null;
  delAbonado: boolean;
  /** Ficha del equipo en el inventario, si ese serial está registrado. */
  equipo: EquipoInv | null;
  /** Motivo por el que este equipo NO se puede autenticar (ya es de otro cliente). */
  impedimento: string | null;
  /** Aviso que no bloquea (bodega de otra sede, equipo depurado…). */
  aviso: string | null;
};
type Estado = {
  modo: "AUTENTICAR" | "VELOCIDAD" | null;
  live: boolean;
  olt: { id: string; name: string } | null;
  plan: { id: string | null; name: string | null; megas: number | null; estado: string } | null;
  velocidad: { trafficIn: number | null; trafficOut: number | null; mbpsIn: number | null; mbpsOut: number | null; origen: string } | null;
  bloqueo: { code: string; message: string } | null;
  candidatos: Candidato[];
  onuActual: { sn: string | null; frame: number | null; slot: number | null; port: number | null; ontId: number | null; runState: string | null } | null;
};
type Resultado = {
  ok: boolean; dryRun?: boolean; message?: string; error?: string; ontId?: string; fsp?: string;
  commands?: string[];
  antes?: { traffic_in: string; traffic_out: string };
  despues?: { traffic_in: string; traffic_out: string };
  equipo?: { code: number; serialCorregido: boolean } | null;
  verificacion?: {
    run_state: string | null; config_state: string | null; match_state: string | null;
    servicePorts: string[]; avisos: string[]; nota?: string | null;
  } | null;
};

/** Etiqueta del desplegable: lo que el técnico necesita para reconocer SU equipo. */
function etiquetaCandidato(c: Candidato): string {
  const partes = [c.sn];
  if (c.model) partes.push(c.model);
  if (c.fsp) partes.push(`puerto ${c.fsp}`);
  // La bodega de la que salió el equipo va en la propia línea: es el dato con el
  // que el técnico reconoce si es suyo o si lo cogió de otro sitio.
  if (c.equipo?.bodega) partes.push(`bodega ${c.equipo.bodega}`);
  else if (!c.equipo) partes.push("sin registrar en inventario");
  const marca = c.impedimento ? "⛔ " : c.delAbonado ? "★ " : c.aviso ? "⚠ " : "";
  return marca + partes.join(" · ");
}

export function AutenticarOnuOrden({
  ticketId, tipo, estadoOrden, onDone,
}: {
  ticketId: string;
  tipo: string | null;
  /** Estado de la orden: en las cerradas no se interroga la OLT sola. */
  estadoOrden?: string | null;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const modo = modoDeOrden(tipo);
  // Cada consulta es una sesión SSH real contra la OLT. En una orden abierta
  // vale la pena (el técnico está a punto de autenticar); en una ya cerrada —y
  // hay miles en el histórico— sería interrogar el equipo cada vez que alguien
  // abre la ficha para leerla. Ahí se pide bajo demanda.
  const abierta = !estadoOrden || estadoOrden === "PENDIENTE" || estadoOrden === "REALIZANDO";
  const [est, setEst] = useState<Estado | null>(null);
  const [cargando, setCargando] = useState(false);
  const [sn, setSn] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Resultado | null>(null);
  /** Equipo del inventario al que corresponde la ONU, cuando su SN no está registrado. */
  const [equipmentId, setEquipmentId] = useState("");
  const [inventario, setInventario] = useState<{ id: string; code: number; serial: string | null; mac: string | null; warehouse: string | null }[]>([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await authFetch(`/support/tickets/${ticketId}/onu`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo consultar la OLT");
      setEst(d);
      // Preselecciona la ONU que ya está registrada a nombre del abonado: en la
      // mayoría de instalaciones es la única candidata correcta y el técnico solo
      // tiene que confirmar.
      // Preselecciona solo entre las que SE PUEDEN autenticar: nunca dejar el
      // desplegable apuntando a un equipo que está a nombre de otro cliente.
      const libres = (d.candidatos ?? []).filter((c: Candidato) => !c.impedimento);
      const suya = libres.find((c: Candidato) => c.delAbonado);
      setSn(suya?.sn ?? (libres.length === 1 ? libres[0].sn : ""));
      setEquipmentId("");
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
      setEst(null);
    } finally {
      setCargando(false);
    }
  }, [authFetch, ticketId]);

  useEffect(() => {
    if (!modo || !abierta) return;
    void cargar();
  }, [modo, abierta, cargar]);

  if (!modo) return null;

  async function ejecutar(url: string, body?: unknown) {
    setBusy(true);
    setRes(null);
    try {
      const r = await authFetch(url, { method: "POST", body: JSON.stringify(body ?? {}) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo completar la operación");
      setRes(d);
      if (d.ok) {
        toast(d.dryRun ? "Plan generado (dry-run)" : "Listo", "check");
        onDone?.();
        void cargar();
      } else {
        toast(d.error || "La OLT rechazó la operación", "alert-triangle");
      }
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setBusy(false);
    }
  }

  const vel = est?.velocidad;
  const elegida = est?.candidatos.find((c) => c.sn === sn) ?? null;
  const puedeAutenticar = !!est && !est.bloqueo && !!sn && !elegida?.impedimento && modo === "AUTENTICAR";
  /** El SN no está en el inventario: se ofrece decir a qué equipo corresponde. */
  const sinRegistrar = !!elegida && !elegida.equipo;

  /** Carga el stock disponible solo cuando hace falta el vinculador (no en cada apertura). */
  const buscarInventario = useCallback(async (q: string) => {
    try {
      const r = await authFetch(`/support/equipment/available${q ? `?search=${encodeURIComponent(q)}` : ""}`);
      setInventario(r.ok ? await r.json() : []);
    } catch { setInventario([]); }
  }, [authFetch]);
  useEffect(() => {
    if (sinRegistrar) void buscarInventario("");
  }, [sinRegistrar, buscarInventario]);

  return (
    <div className="mb-3 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name="radio-tower" size={15} className="text-brand" />
          {modo === "AUTENTICAR" ? "Autenticación de la ONU" : "Velocidad de la ONU"}
        </div>
        <div className="flex items-center gap-2">
          {est && !est.live && <Badge label="DRY-RUN" tone="info" />}
          <Button variant="secondary" size="sm" disabled={cargando || busy} onClick={() => void cargar()}>
            <Icon name="refresh-cw" size={13} /> {cargando ? "Consultando…" : est ? "Refrescar" : "Consultar la OLT"}
          </Button>
        </div>
      </div>

      {cargando && !est && <p className="text-[12px] text-text-tertiary">Consultando la OLT por SSH… (unos segundos)</p>}
      {!cargando && !est && !abierta && (
        <p className="text-[12px] text-text-tertiary">
          Esta orden ya está cerrada. Pulse <b>Consultar la OLT</b> si necesita revisar o rehacer la autenticación.
        </p>
      )}

      {est && (
        <>
          {/* Qué se va a aplicar: OLT, plan y velocidad. Sin números de índice a la vista. */}
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-text-secondary">
            <span><b className="text-text-primary">OLT:</b> {est.olt?.name ?? "—"}</span>
            <span><b className="text-text-primary">Plan:</b> {est.plan?.name ?? "—"}</span>
            {vel && (
              <span className="inline-flex items-center gap-1">
                <Icon name="gauge" size={13} className="text-brand" />
                {/* `trafficIn` es el índice `inbound` = columna RX = BAJADA del
                    abonado; `trafficOut` (`outbound`/TX) es la subida. */}
                <b className="text-text-primary">Velocidad del plan:</b>
                {vel.mbpsIn != null ? `${vel.mbpsIn.toLocaleString("es-CO")} Mbps bajada` : `traffic-table ${vel.trafficIn ?? "—"} bajada`}
                {" / "}
                {vel.mbpsOut != null ? `${vel.mbpsOut.toLocaleString("es-CO")} Mbps subida` : `traffic-table ${vel.trafficOut ?? "—"} subida`}
              </span>
            )}
          </div>

          {est.bloqueo ? (
            <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
              <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
              {est.bloqueo.message}
              {est.bloqueo.code === "SIN_VELOCIDAD" && (
                <Link href="/configuracion/planes?tab=olt" className="ml-1 font-semibold text-brand hover:underline">
                  Abrir Velocidad en OLT
                </Link>
              )}
            </div>
          ) : modo === "AUTENTICAR" ? (
            <div className="flex flex-col gap-2">
              <label className="text-[12px] text-text-secondary">
                ONU a autenticar
                <Select value={sn} onChange={(e) => setSn(e.target.value)} className="mt-0.5">
                  <option value="">— Elija el equipo instalado ({est.candidatos.length} esperando) —</option>
                  {est.candidatos.map((c) => (
                    <option key={c.sn} value={c.sn}>{etiquetaCandidato(c)}</option>
                  ))}
                </Select>
              </label>
              <p className="text-[11.5px] text-text-tertiary">
                ★ equipo ya registrado a este abonado · ⚠ revise el aviso · ⛔ instalado en otro cliente, no se puede usar.
              </p>

              {/* Lo que pasa con el equipo elegido: de qué bodega salió, si está
                  en otro cliente (no se deja seguir) o si no está en inventario. */}
              {elegida?.impedimento && (
                <p className="rounded-lg border border-error-text/40 bg-error-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-error-text" />
                  {elegida.impedimento}
                </p>
              )}
              {elegida?.aviso && !elegida.impedimento && (
                <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-text-secondary">
                  <Icon name="alert-triangle" size={13} className="mr-1 inline text-warning-text" />
                  {elegida.aviso} Revise que sea el equipo que usted instaló antes de continuar.
                </p>
              )}
              {elegida?.equipo && !elegida.impedimento && (
                <p className="text-[11.5px] text-text-tertiary">
                  Equipo <b>{elegida.equipo.code}</b> · bodega {elegida.equipo.bodega ?? "—"}
                  {elegida.equipo.status ? ` · ${elegida.equipo.status}` : ""} — al autenticar queda registrado a nombre del abonado.
                </p>
              )}

              {/* SN que no está en el inventario. No se inventa una unidad nueva:
                  se pregunta a cuál corresponde y se le graba el serial bueno.
                  Es opcional — el alta en la OLT no depende de esto. */}
              {sinRegistrar && (
                <div className="rounded-lg border border-border-subtle bg-surface-2 p-3">
                  <p className="mb-1.5 text-[12px] text-text-secondary">
                    Este serial no está en el inventario. Si sabe a qué equipo de bodega corresponde,
                    indíquelo: quedará a nombre del abonado y se le corregirá el serial con el que
                    reporta la OLT. <span className="text-text-tertiary">(opcional)</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} className="min-w-[240px] flex-1">
                      <option value="">— No indicar —</option>
                      {inventario.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.code} · {e.serial || "sin serial"} · {e.mac || "sin MAC"}{e.warehouse ? ` · ${e.warehouse}` : ""}
                        </option>
                      ))}
                    </Select>
                    <input
                      className="min-w-[140px] flex-1 rounded-lg border border-border-default bg-surface px-3 py-1.5 text-[12px] text-text-primary"
                      placeholder="Buscar por serial o MAC…"
                      onChange={(e) => void buscarInventario(e.target.value)}
                    />
                  </div>
                </div>
              )}
              {est.onuActual?.sn && (
                <p className="rounded-lg bg-surface-2 px-3 py-1.5 text-[11.5px] text-text-tertiary">
                  Ojo: este abonado ya tiene la ONU <span className="font-mono">{est.onuActual.sn}</span> vinculada
                  {est.onuActual.slot != null ? ` en ${est.onuActual.frame}/${est.onuActual.slot}/${est.onuActual.port}` : ""}.
                  Si es un cambio de equipo, retire la anterior desde Red › OLT cuando termine.
                </p>
              )}
              <div className="flex justify-end">
                <Button
                  disabled={!puedeAutenticar || busy}
                  onClick={() => void ejecutar(`/support/tickets/${ticketId}/onu/autenticar`, { sn, ...(equipmentId ? { equipmentId } : {}) })}
                >
                  <Icon name="wand-sparkles" size={15} className="mr-1" />
                  {busy ? "Autenticando…" : est.live ? "Autenticar ONU" : "Generar plan (dry-run)"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-text-secondary">
                ONU del abonado: <span className="font-mono font-semibold text-text-primary">{est.onuActual?.sn ?? "—"}</span>
                {est.onuActual?.slot != null && <span className="ml-2 text-text-tertiary">puerto {est.onuActual.frame}/{est.onuActual.slot}/{est.onuActual.port}</span>}
                {est.onuActual?.runState && <span className="ml-2 text-text-tertiary">({est.onuActual.runState})</span>}
              </p>
              <div className="flex justify-end">
                <Button disabled={busy} onClick={() => void ejecutar(`/support/tickets/${ticketId}/onu/velocidad`)}>
                  <Icon name="gauge" size={15} className="mr-1" />
                  {busy ? "Aplicando…" : est.live ? "Aplicar velocidad del plan" : "Generar plan (dry-run)"}
                </Button>
              </div>
            </div>
          )}

          {res && <ResultadoOnu res={res} />}
        </>
      )}
    </div>
  );
}

/**
 * Resultado del alta. Que el comando no fallara no significa que el abonado
 * tenga servicio: la OLT acepta el alta y luego marca la config como fallida.
 * Por eso se enseña la verificación, no solo un "OK".
 */
function ResultadoOnu({ res }: { res: Resultado }) {
  const v = res.verificacion;
  const problema = !res.ok || !!v?.avisos?.length;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-[12px] ${problema ? "border-warning bg-warning-soft" : "border-success-text/30 bg-success-soft"}`}>
      <div className="flex items-center gap-1.5 font-semibold text-text-primary">
        <Icon name={problema ? "alert-triangle" : "check"} size={14} className={problema ? "text-warning-text" : "text-success-text"} />
        {res.ok ? (res.message ?? "Listo") : (res.error ?? "No se pudo completar")}
      </div>
      {res.ontId && <div className="mt-1">ONT-ID asignado: <span className="font-mono font-bold">{res.ontId}</span>{res.fsp ? ` · puerto ${res.fsp}` : ""}</div>}
      {res.equipo && (
        <div className="mt-1 text-text-secondary">
          Equipo <b>{res.equipo.code}</b> registrado a nombre del abonado
          {res.equipo.serialCorregido ? " · se corrigió su serial con el que reporta la OLT" : ""}.
        </div>
      )}
      {res.despues && (
        <div className="mt-1 text-text-secondary">
          Traffic-table: bajada {res.antes?.traffic_in} → <b>{res.despues.traffic_in}</b> · subida {res.antes?.traffic_out} → <b>{res.despues.traffic_out}</b>
        </div>
      )}
      {v && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Badge label={`estado: ${v.run_state ?? "—"}`} tone={/online/i.test(v.run_state ?? "") ? "success" : "error"} />
          <Badge label={`config: ${v.config_state ?? "—"}`} tone={/normal/i.test(v.config_state ?? "") ? "success" : "default"} />
          <Badge label={`${v.servicePorts?.length ?? 0} service-port(s)`} tone={v.servicePorts?.length ? "success" : "error"} />
        </div>
      )}
      {!!v?.avisos?.length && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-text-secondary">
          {v.avisos.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      )}
      {v?.nota && !v.avisos?.length && <p className="mt-1.5 text-[11.5px] text-text-tertiary">{v.nota}</p>}
      {!!res.commands?.length && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-black/80 p-2 font-mono text-[11px] text-green-300">{res.commands.join("\n")}</pre>
      )}
    </div>
  );
}
