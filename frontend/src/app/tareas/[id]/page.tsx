"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { fmtDate } from "@/lib/format";
import { ACCEPT_ADJUNTO, ACCEPT_IMAGEN } from "@/lib/adjuntos";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { MOTIVO_GEO, pedirUbicacion } from "@/lib/geo";

/**
 * Ficha de una tarea: lo que hay que hacer arriba y lo que se lleva hecho abajo.
 *
 * La tarea sólo tenía lista y modal de edición: se podía cambiar de estado, pero no
 * decir POR QUÉ ni QUÉ se intentó, y quien la retomaba días después empezaba a
 * ciegas. Esta pantalla es la misma idea del seguimiento de una orden de servicio
 * (`/soporte/[id]`) traída a la tarea: un hilo con quién escribió, cuándo, en qué
 * quedó y —si hizo falta probarlo— la foto.
 */

const STATUS_LABEL: Record<string, string> = { DUE: "Pendiente", PROGRESS: "En progreso", DONE: "Hecha" };
const STATUS_TONE: Record<string, "default" | "success" | "error" | "warning" | "info"> = {
  DUE: "warning", PROGRESS: "info", DONE: "success",
};
const PRIORITY_LABEL: Record<string, string> = { LOW: "Baja", MEDIUM: "Media", HIGH: "Alta", URGENT: "Urgente" };
const PRIORITY_TONE: Record<string, "default" | "error" | "warning" | "info"> = {
  LOW: "default", MEDIUM: "info", HIGH: "warning", URGENT: "error",
};
const SOURCE_LABEL: Record<string, string> = { CHATBOT: "bot", SISTEMA: "automático", LEGACY: "sistema anterior" };

/** En qué quedó (misma lista cerrada que valida el backend en `TASK_STAGES`). */
const ETAPAS = [
  "Avance",
  "A la espera de un tercero",
  "A la espera del cliente",
  "Bloqueada",
  "Se reprograma",
  "Resuelta",
  "No procede",
];

/**
 * El paso natural desde el estado en el que está: la tarea se abre para empezarla o
 * para darla por hecha, y eso va como botón grande y no escondido en un desplegable.
 */
const SIGUIENTE: Record<string, { estado: string; label: string; icon: string }> = {
  DUE: { estado: "PROGRESS", label: "Empezar", icon: "play" },
  PROGRESS: { estado: "DONE", label: "Marcar hecha", icon: "check" },
};

type Nota = {
  id: string; message: string | null; stage: string | null; auto: boolean;
  author: string | null; attach: string | null; geoLat: string | null; geoLng: string | null; at: string;
};
type Adjunto = { id: string; name: string; size: number; by: string | null; at: string };

const fmtT = (d: string | null) => (d ? new Date(d).toLocaleString("es-CO") : "—");
const fmtPeso = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** El detalle heredado trae HTML del WYSIWYG del legacy: se pinta como texto plano. */
const stripHtml = (s: string | null) =>
  (s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function CardTitle({ icon, children, right }: { icon: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
        <Icon name={icon} size={15} className="text-brand" />
        {children}
      </div>
      {right}
    </div>
  );
}

/** Un dato de la ficha (etiqueta a la izquierda, valor a la derecha). */
function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 border-b border-border-subtle py-1.5 last:border-0">
      <span className="w-32 shrink-0 text-[11.5px] uppercase tracking-wide text-text-tertiary">{k}</span>
      <span className="min-w-0 flex-1 text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

/** Preview de la foto del seguimiento. El endpoint pide sesión, así que un `<img src>`
 *  plano recibiría 401: se baja como blob, igual que en la orden. */
function NotaImagen({ taskId, notaId }: { taskId: string; notaId: string }) {
  const { authFetch } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  useEffect(() => {
    let obj: string | null = null;
    void authFetch(`/tasks/${taskId}/notes/${notaId}/attachment`)
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { obj = URL.createObjectURL(b); setUrl(obj); })
      .catch(() => setFail(true));
    return () => { if (obj) URL.revokeObjectURL(obj); };
  }, [authFetch, taskId, notaId]);
  if (fail) return <p className="mt-1 text-[11px] text-error-text">No se pudo cargar la imagen.</p>;
  if (!url) return <div className="mt-1 h-40 w-56 animate-pulse rounded-lg bg-surface-2" />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block">
      <img src={url} alt="Evidencia de la tarea" className="max-h-64 max-w-xs rounded-lg border border-border-subtle object-cover" />
    </a>
  );
}

export default function TareaDetallePage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [t, setT] = useState<any | null>(null);
  const [err, setErr] = useState("");
  const [assignees, setAssignees] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  // Formulario de documentación.
  const [texto, setTexto] = useState("");
  const [etapa, setEtapa] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);

  const reload = useCallback(() => {
    void authFetch(`/tasks/${id}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        throw new Error((await r.json().catch(() => null))?.message ?? "");
      })
      .then(setT)
      .catch((e) => setErr(e?.message || "Tarea no encontrada."));
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading) return;
    reload();
    void authFetch("/tasks/assignees").then(listaJson<{ id: number; name: string }>).then(setAssignees).catch(() => {});
  }, [authLoading, authFetch, reload]);

  /** Cambia un campo de la tarea. Cada cambio deja su renglón en el seguimiento (lo
   *  escribe el backend), así que después de guardar hay que releer el hilo. */
  const patch = useCallback(async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      const res = await authFetch(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(okMsg, "check");
      reload();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo guardar."), "alert-triangle");
    } finally {
      setBusy(false);
    }
  }, [authFetch, id, reload]);

  /** Documentar: texto y/o etapa, con foto si la hay. */
  async function documentar() {
    if (!texto.trim() && !etapa && !foto) return;
    setBusy(true);
    try {
      if (foto) {
        // Con foto va por multipart e intenta geo-etiquetar, igual que la evidencia
        // de una visita: sin HTTPS el navegador no da coordenadas y sube sin ellas.
        const geo = await pedirUbicacion();
        const fd = new FormData();
        fd.append("file", foto);
        if (texto.trim()) fd.append("message", texto.trim());
        if (etapa) fd.append("stage", etapa);
        if (geo.ok) { fd.append("lat", String(geo.lat)); fd.append("lng", String(geo.lng)); }
        const res = await authFetch(`/tasks/${id}/notes/attach`, { method: "POST", body: fd });
        const d = await res.json().catch(() => null);
        if (!res.ok) throw new Error(d?.message || "No se pudo subir la foto");
        toast(geo.ok ? "Documentado con foto y ubicación." : `Documentado con foto. ${MOTIVO_GEO[geo.motivo]}`, "check");
      } else {
        const res = await authFetch(`/tasks/${id}/notes`, {
          method: "POST",
          body: JSON.stringify({ message: texto.trim() || undefined, stage: etapa || undefined }),
        });
        const d = await res.json().catch(() => null);
        if (!res.ok) throw new Error(d?.message || "Error");
        toast("Tarea documentada.", "check");
      }
      setTexto(""); setEtapa(""); setFoto(null);
      reload();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo documentar."), "alert-triangle");
    } finally {
      setBusy(false);
    }
  }

  /** Adjuntos: la planilla, la cotización, el PDF. Suben ya (la tarea existe). */
  async function adjuntar(files: File[]) {
    if (!files.length) return;
    setSubiendo(true);
    try {
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        const res = await authFetch(`/tasks/${id}/files`, { method: "POST", body: fd });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || `No se pudo subir ${f.name}`);
      }
      toast(files.length === 1 ? "Archivo adjuntado." : `${files.length} archivos adjuntados.`, "check");
      reload();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo adjuntar."), "alert-triangle");
      reload();
    } finally {
      setSubiendo(false);
    }
  }

  async function bajarAdjunto(f: Adjunto) {
    try {
      const res = await authFetch(`/tasks/${id}/files/${f.id}/download`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo descargar");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = f.name; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo abrir el archivo."), "alert-triangle");
    }
  }

  async function quitarAdjunto(f: Adjunto) {
    try {
      const res = await authFetch(`/tasks/${id}/files/${f.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo eliminar");
      reload();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo eliminar el adjunto."), "alert-triangle");
    }
  }

  if (authLoading || (!t && !err)) return <PageSkeleton />;
  if (err)
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">
        {err} <Link href="/tareas" className="text-brand">Volver a tareas</Link>
      </div>
    );

  const hoy = new Date().toISOString().slice(0, 10);
  const vencida = t.status !== "DONE" && !!t.dueDate && String(t.dueDate).slice(0, 10) < hoy;
  const paso = SIGUIENTE[t.status];
  const notas: Nota[] = t.notes ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl">
      <DetailHeader
        backHref="/tareas"
        backLabel="Tareas"
        icon="clipboard-list"
        title={t.name || "Tarea sin nombre"}
        badges={
          <>
            <Badge label={STATUS_LABEL[t.status] ?? t.status} tone={STATUS_TONE[t.status] ?? "default"} />
            <Badge label={PRIORITY_LABEL[t.priority] ?? t.priority} tone={PRIORITY_TONE[t.priority] ?? "default"} />
            {vencida && <Badge label="Vencida" tone="error" />}
          </>
        }
        subtitle={
          <>
            Creada por {t.author ?? "autor desconocido"}
            {t.authorSource && SOURCE_LABEL[t.authorSource] ? ` (${SOURCE_LABEL[t.authorSource]})` : ""} · {fmtDate(t.tdate)}
          </>
        }
        actions={
          paso ? (
            <Button variant="primary" disabled={busy} onClick={() => void patch({ status: paso.estado }, `Estado: ${STATUS_LABEL[paso.estado]}`)}>
              <Icon name={paso.icon} size={15} /> {paso.label}
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => void patch({ status: "PROGRESS" }, "Tarea reabierta")}>
              <Icon name="rotate-cw" size={15} /> Reabrir
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-4">
        {/* Ficha: lo que hay que hacer y de quién es. Los tres controles que se
            mueven a diario (estado, prioridad, responsable) se cambian aquí mismo;
            el resto se edita desde el listado. */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <CardTitle icon="clipboard-list">Información</CardTitle>
          <KV k="Responsable">
            <Select
              value={t.assigneeId ?? ""}
              disabled={busy}
              onChange={(e) => void patch({ assigneeId: Number(e.target.value) || 0 }, "Responsable actualizado")}
              className="max-w-xs"
            >
              <option value="">Sin asignar</option>
              {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </KV>
          <KV k="Estado">
            <Select value={t.status} disabled={busy} onChange={(e) => void patch({ status: e.target.value }, "Estado actualizado")} className="max-w-xs">
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </KV>
          <KV k="Prioridad">
            <Select value={t.priority} disabled={busy} onChange={(e) => void patch({ priority: e.target.value }, "Prioridad actualizada")} className="max-w-xs">
              {["LOW", "MEDIUM", "HIGH", "URGENT"].map((k) => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}
            </Select>
          </KV>
          <KV k="Inicio">{fmtDate(t.start)}</KV>
          <KV k="Vence">
            <span className={vencida ? "font-semibold text-error-text" : undefined}>{fmtDate(t.dueDate)}</span>
          </KV>
          <KV k="Orden">
            {t.orderId ? (
              <Link href={`/soporte?search=${t.orderId}`} className="text-brand hover:underline">
                #{t.orderId}
              </Link>
            ) : (
              <span className="text-text-tertiary">Nota suelta, sin orden asociada</span>
            )}
          </KV>
          {t.description && <KV k="Detalle">{stripHtml(t.description)}</KV>}
        </div>

        {/* Adjuntos: lo que hay que trabajar (la planilla, la cotización). El
            seguimiento de abajo dice CUÁNDO apareció cada uno. */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <CardTitle
            icon="paperclip"
            right={
              <label className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-default px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 ${subiendo ? "pointer-events-none opacity-60" : ""}`}>
                <Icon name={subiendo ? "loader" : "paperclip"} size={13} className={subiendo ? "animate-spin" : ""} />
                {subiendo ? "Subiendo…" : "Adjuntar archivo"}
                <input
                  type="file" className="hidden" multiple accept={ACCEPT_ADJUNTO}
                  onChange={(e) => { void adjuntar(Array.from(e.target.files ?? [])); e.target.value = ""; }}
                />
              </label>
            }
          >
            Adjuntos ({t.files?.length ?? 0})
          </CardTitle>
          {t.files?.length ? (
            <div className="flex flex-col gap-1.5">
              {t.files.map((f: Adjunto) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border-subtle px-2.5 py-1.5">
                  <Icon name="paperclip" size={13} className="shrink-0 text-text-tertiary" />
                  <button type="button" onClick={() => void bajarAdjunto(f)} className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-brand hover:underline">
                    {f.name}
                  </button>
                  <span className="shrink-0 text-[11px] text-text-tertiary">{fmtPeso(f.size)}{f.by ? ` · ${f.by}` : ""}</span>
                  <button type="button" title="Quitar adjunto" onClick={() => void quitarAdjunto(f)} className="tap shrink-0 rounded p-1 text-text-tertiary hover:bg-error-soft hover:text-error-text">
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-tertiary">Excel, CSV, PDF, Word, imágenes o ZIP (hasta 20 MB cada uno).</p>
          )}
        </div>

        {/* Seguimiento. Primero lo que ya pasó y al pie el formulario: se lee como
            una conversación y quien llega a documentar baja habiendo visto lo que
            hicieron antes. Igual que en la orden de servicio. */}
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <CardTitle icon="message-square">Seguimiento ({notas.length})</CardTitle>

          {notas.length ? (
            <ol className="mb-3 flex flex-col gap-3">
              {notas.map((n) => (
                <li key={n.id} className="flex gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2">
                    <Icon name={n.auto ? "clock" : "message-square"} size={13} className="text-text-tertiary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-text-tertiary">
                      <span className="font-semibold text-text-secondary">{n.author ?? "Sistema"}</span>
                      {" · "}{fmtT(n.at)}
                    </p>
                    {n.stage && <span className="mt-1 inline-block"><Badge label={n.stage} tone="info" /></span>}
                    {n.message && (
                      // Lo que anota el sistema (cambió el estado, se adjuntó un
                      // fichero) se pinta apagado: la bitácora automática no puede
                      // confundirse con lo que alguien se sentó a escribir.
                      <p className={`mt-0.5 whitespace-pre-wrap text-[13px] ${n.auto ? "italic text-text-tertiary" : "text-text-primary"}`}>{n.message}</p>
                    )}
                    {n.attach && <NotaImagen taskId={String(id)} notaId={n.id} />}
                    {n.geoLat && n.geoLng && (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${n.geoLat},${n.geoLng}`}
                        target="_blank" rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
                      >
                        <Icon name="map-pin" size={11} /> Ubicación de la foto
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mb-3 text-[12px] text-text-tertiary">Todavía no hay nada documentado.</p>
          )}

          <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
            <Select value={etapa} onChange={(e) => setEtapa(e.target.value)}>
              <option value="">— En qué quedó (opcional) —</option>
              {ETAPAS.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
            <Textarea rows={3} placeholder="Escribe qué se hizo o en qué va…" value={texto} onChange={(e) => setTexto(e.target.value)} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Dos botones a propósito: `capture="environment"` abre la cámara y se
                  salta el selector, así que con uno solo la galería queda inalcanzable. */}
              <div className="inline-flex items-center gap-1.5">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                  <Icon name="camera" size={14} /> Cámara
                  <input type="file" accept={ACCEPT_IMAGEN} capture="environment" className="hidden" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                  <Icon name="image" size={14} /> Galería
                  <input type="file" accept={ACCEPT_IMAGEN} className="hidden" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} />
                </label>
              </div>
              {foto && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
                  <Icon name="file-text" size={12} /> {foto.name}
                  <button type="button" onClick={() => setFoto(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
                </span>
              )}
              <span className="grow" />
              <Button disabled={busy || (!texto.trim() && !etapa && !foto)} onClick={() => void documentar()}>
                {foto ? "Subir evidencia" : "Documentar"}
              </Button>
            </div>
            {foto && <p className="text-[10px] text-text-tertiary">Se intentará adjuntar la ubicación del dispositivo (requiere HTTPS; sobre HTTP la foto sube sin coordenadas).</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
