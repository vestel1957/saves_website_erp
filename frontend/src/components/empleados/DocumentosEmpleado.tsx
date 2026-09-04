"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";
import { ACCEPT_DOCUMENTO } from "@/lib/adjuntos";

/** Mismos valores que `StaffDocumentKind` en el backend. */
const TIPOS = [
  { value: "CV", label: "Hoja de vida" },
  { value: "IDENTITY", label: "Documento de identidad" },
  { value: "CONTRACT", label: "Contrato" },
  { value: "CERTIFICATE", label: "Certificado / examen" },
  { value: "OTHER", label: "Otro" },
];

const ICONO_TIPO: Record<string, string> = {
  CV: "file-text",
  IDENTITY: "contact",
  CONTRACT: "file-signature",
  CERTIFICATE: "graduation-cap",
  OTHER: "paperclip",
};

/** Tamaño legible. 384 000 bytes no le dice nada a nadie; "375 KB" sí. */
function tamano(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Carpeta de documentos del funcionario.
 *
 * Los archivos NO se enlazan con un `<a href>` directo: van por `authFetch` y se
 * abren como blob. Son cédulas y contratos, y el endpoint exige sesión y permiso
 * de RRHH — un enlace plano no llevaría las credenciales y además dejaría la URL
 * en el historial del navegador.
 */
export function DocumentosEmpleado({ staffId, puedeEditar }: { staffId: string; puedeEditar: boolean }) {
  const { authFetch } = useAuth();
  const [data, setData] = useState<any>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [kind, setKind] = useState("CV");
  const [descripcion, setDescripcion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const r = await authFetch(`/staff/${staffId}/documents`);
      if (!r.ok) throw new Error(r.status === 403 ? "No tienes permiso para ver los documentos de empleados." : `El servidor respondió ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setCargando(false);
    }
  }, [authFetch, staffId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const subir = async (file: File) => {
    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      if (descripcion.trim()) fd.append("description", descripcion.trim());
      // Sin Content-Type a mano: el navegador tiene que poner el boundary del
      // multipart, y fijarlo rompe la subida.
      const r = await authFetch(`/staff/${staffId}/documents`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      toast("Documento subido.", "check");
      setDescripcion("");
      if (inputRef.current) inputRef.current.value = "";
      await cargar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    } finally {
      setSubiendo(false);
    }
  };

  const descargar = async (doc: any) => {
    try {
      const r = await authFetch(`/staff/${staffId}/documents/${doc.id}/download`);
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    }
  };

  const borrar = async (doc: any) => {
    if (!confirm(`¿Eliminar "${doc.fileName}"? No se puede deshacer.`)) return;
    try {
      const r = await authFetch(`/staff/${staffId}/documents/${doc.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(await r.text());
      toast("Documento eliminado.", "check");
      await cargar();
    } catch (e) {
      toast(mensajeDeError(e), "alert-triangle");
    }
  };

  if (cargando) return <div className="rounded-xl border border-border-subtle bg-surface p-6 text-[13px] text-text-secondary">Cargando documentos…</div>;

  if (error) {
    return (
      <div className="rounded-xl border border-error-border bg-error-soft p-4 text-[13px] text-error-text">
        <div className="mb-1 flex items-center gap-1.5 font-semibold"><Icon name="alert-triangle" size={15} /> No se pudieron cargar los documentos</div>
        {error}
      </div>
    );
  }

  const documentos = data?.documentos ?? [];
  const porTipo = data?.porTipo ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Qué hay y qué falta, de un vistazo. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {porTipo.map((t: any) => (
          <div key={t.kind} className={`rounded-xl border p-3 ${t.total > 0 ? "border-border-subtle bg-surface" : "border-dashed border-border-default bg-surface-2"}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary">
              <Icon name={ICONO_TIPO[t.kind] ?? "paperclip"} size={13} /> {t.label}
            </div>
            <div className={`mt-0.5 text-[18px] font-bold ${t.total > 0 ? "text-text-primary" : "text-text-tertiary"}`}>
              {t.total > 0 ? t.total : "—"}
            </div>
          </div>
        ))}
      </div>

      {puedeEditar && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4">
          <div className="mb-2.5 flex items-center gap-2 text-[13px] font-bold text-text-primary">
            <Icon name="upload" size={15} className="text-brand" /> Subir documento
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Tipo">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </Field>
            <Field label="Descripción (opcional)">
              <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Ej: contrato firmado 2026" />
            </Field>
            <Field label="Archivo">
              <input ref={inputRef} type="file" disabled={subiendo}
                accept={ACCEPT_DOCUMENTO}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void subir(f); }}
                className="block w-full text-[12px] text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-3 file:py-2 file:text-[12px] file:font-semibold file:text-on-brand hover:file:opacity-90 disabled:opacity-50" />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">
            PDF, imagen o Word · máximo 20 MB. Los documentos solo los ven quienes tengan permiso de RRHH.
          </p>
        </div>
      )}

      <DataTable rows={documentos} empty={puedeEditar ? "Este empleado todavía no tiene documentos. Sube el primero arriba." : "Este empleado todavía no tiene documentos."}
        columns={[
          { key: "k", header: "Tipo", render: (r: any) => (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <Icon name={ICONO_TIPO[r.kind] ?? "paperclip"} size={14} className="text-brand" /> {r.kindLabel}
            </span>
          ) },
          { key: "f", header: "Archivo", render: (r: any) => (
            <div className="flex flex-col">
              <span className="font-medium text-text-primary">{r.fileName}</span>
              {r.description && <span className="text-[11px] text-text-tertiary">{r.description}</span>}
            </div>
          ) },
          { key: "s", header: "Tamaño", align: "right", render: (r: any) => <span className="text-text-secondary">{tamano(r.size)}</span> },
          { key: "u", header: "Subido por", render: (r: any) => r.uploadedBy ?? "—" },
          { key: "d", header: "Fecha", render: (r: any) => fmtDate(r.createdAt) },
          { key: "a", header: "", align: "right", render: (r: any) => (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => void descargar(r)} title="Descargar">
                <Icon name="download" size={14} />
              </Button>
              {puedeEditar && (
                <Button size="sm" variant="ghost" onClick={() => void borrar(r)} title="Eliminar">
                  <Icon name="trash" size={14} className="text-error-text" />
                </Button>
              )}
            </div>
          ) },
        ]} />
    </div>
  );
}
