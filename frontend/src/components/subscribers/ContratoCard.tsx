"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { fmtDate } from "@/lib/format";
import { mensajeDeError } from "@/lib/errores";
import { ACCEPT_IMAGEN } from "@/lib/adjuntos";
import { FirmaModal } from "./FirmaModal";

type Estado = {
  contractDate: string | null;
  clausula: {
    numero: number | null;
    nombre: string;
    meses: number;
    vTotal: number;
    valores: number[];
    fin: string | null;
    vigente: boolean | null;
  } | null;
  firma: { at: string | null; by: string | null } | null;
  firmaLegacySinArchivo: boolean;
  huella: { at: string | null } | null;
};

/**
 * En qué mes de permanencia va el contrato (1 = el primero).
 *
 * Se cuenta por meses cumplidos desde la fecha del contrato, que es como está
 * escrita la tabla del contrato ("valor a pagar si termina en el mes N").
 */
function mesDePermanencia(desde: string | null): number | null {
  if (!desde) return null;
  const ini = new Date(desde);
  const hoy = new Date();
  const meses = (hoy.getUTCFullYear() - ini.getUTCFullYear()) * 12 + (hoy.getUTCMonth() - ini.getUTCMonth());
  const ajuste = hoy.getUTCDate() >= ini.getUTCDate() ? 0 : -1;
  return meses + ajuste + 1;
}

/**
 * El contrato del cliente en la ficha: permanencia, firma, huella y los dos PDF.
 *
 * La cifra que importa no es la cláusula sino lo que el cliente pagaría si se
 * retira HOY: es lo que pregunta quien llama a cancelar, y es la única forma de
 * usar la tabla de permanencia sin abrir el PDF y contar meses a mano.
 */
export function ContratoCard({
  subscriberId,
  nombre,
  openPdf,
}: {
  subscriberId: string;
  nombre?: string | null;
  openPdf: (path: string) => void | Promise<void>;
}) {
  const { authFetch } = useAuth();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [firmaUrl, setFirmaUrl] = useState<string | null>(null);
  const [huellaUrl, setHuellaUrl] = useState<string | null>(null);
  const [firmando, setFirmando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const cargar = useCallback(() => {
    void authFetch(`/subscribers/${subscriberId}/contrato`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudo cargar el contrato"))))
      .then(setEstado)
      .catch(() => setEstado(null));
  }, [authFetch, subscriberId]);

  useEffect(cargar, [cargar]);

  // Las imágenes van por la API con token, así que no se pueden poner en un <img
  // src>: se piden por fetch y se muestran como blob. Se revoca al cambiar para no
  // dejar objetos colgando en memoria.
  useEffect(() => {
    let vivo = true;
    const urls: string[] = [];
    async function traer(cual: "firma" | "huella", set: (u: string | null) => void, hay: boolean) {
      if (!hay) return set(null);
      try {
        const r = await authFetch(`/subscribers/${subscriberId}/${cual}.png`);
        if (!r.ok) return set(null);
        const url = URL.createObjectURL(await r.blob());
        urls.push(url);
        if (vivo) set(url);
        else URL.revokeObjectURL(url);
      } catch {
        set(null);
      }
    }
    void traer("firma", setFirmaUrl, !!estado?.firma);
    void traer("huella", setHuellaUrl, !!estado?.huella);
    return () => {
      vivo = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [authFetch, subscriberId, estado?.firma, estado?.huella]);

  async function subirHuella(file: File) {
    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/subscribers/${subscriberId}/huella`, { method: "POST", body: fd });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message ?? "No se pudo subir la huella");
      }
      toast("Huella guardada");
      cargar();
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo subir la huella", "alert-circle");
    } finally {
      setSubiendo(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function quitar(cual: "firma" | "huella") {
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/${cual}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast(cual === "firma" ? "Firma eliminada" : "Huella eliminada");
      cargar();
    } catch {
      toast("No se pudo eliminar", "alert-circle");
    }
  }

  const c = estado?.clausula;
  const mes = c ? mesDePermanencia(estado?.contractDate ?? null) : null;
  // Fuera de la ventana de permanencia no hay nada que pagar: la tabla solo cubre
  // sus N meses y extrapolarla inventaría una deuda.
  const valorHoy = c && mes && mes >= 1 && mes <= c.valores.length ? c.valores[mes - 1] : null;

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name="file-signature" size={15} className="text-brand" />
          Contrato
        </div>
        <div className="flex gap-1.5">
          <Button variant="secondary" className="!px-2 !py-1 !text-[11px]" onClick={() => void openPdf(`/subscribers/${subscriberId}/contract.pdf`)}>
            <Icon name="file-text" size={13} /> Contrato
          </Button>
          <Button variant="secondary" className="!px-2 !py-1 !text-[11px]" onClick={() => void openPdf(`/subscribers/${subscriberId}/anexo.pdf`)}>
            <Icon name="scroll-text" size={13} /> Anexo
          </Button>
        </div>
      </div>

      {/* ── Permanencia ── */}
      {c ? (
        <div className="mb-3 rounded-lg border border-border-subtle bg-surface-2/40 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-text-primary">{c.nombre}</span>
            <Badge
              label={c.vigente === false ? "Permanencia cumplida" : `Vigente hasta ${fmtDate(c.fin)}`}
              tone={c.vigente === false ? "success" : "info"}
            />
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
            <span className="text-text-tertiary">Cargo por conexión</span>
            <span className="text-right font-medium text-text-primary">{cop(c.vTotal)}</span>
            <span className="text-text-tertiary">Permanencia</span>
            <span className="text-right font-medium text-text-primary">
              {c.meses} meses{mes && mes >= 1 && mes <= c.meses ? ` · va en el mes ${mes}` : ""}
            </span>
            {valorHoy != null && (
              <>
                <span className="text-text-tertiary">Si se retira hoy paga</span>
                <span className="text-right font-bold text-warning-text">{cop(valorHoy)}</span>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="mb-3 rounded-lg border border-border-subtle bg-surface-2/40 p-2.5 text-[12px] text-text-tertiary">
          Sin cláusula de permanencia: puede terminar el contrato cuando quiera sin pagar nada por ese concepto.
        </p>
      )}

      {/* ── Firma y huella ── */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-text-tertiary">Firma</span>
            {estado?.firma && (
              <button type="button" onClick={() => void quitar("firma")} className="tap text-text-tertiary hover:text-error-text" title="Quitar firma">
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
          <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border-subtle bg-surface-2/30 p-1">
            {firmaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={firmaUrl} alt="Firma del cliente" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="px-2 text-center text-[11px] text-text-tertiary">
                {estado?.firmaLegacySinArchivo ? "Firmado en el legacy (sin imagen)" : "Sin firma"}
              </span>
            )}
          </div>
          <Button variant="secondary" className="mt-1.5 w-full !py-1 !text-[11px]" onClick={() => setFirmando(true)}>
            <Icon name="pencil" size={13} /> {estado?.firma ? "Volver a firmar" : "Firmar"}
          </Button>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-text-tertiary">Huella</span>
            {estado?.huella && (
              <button type="button" onClick={() => void quitar("huella")} className="tap text-text-tertiary hover:text-error-text" title="Quitar huella">
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
          <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border-subtle bg-surface-2/30 p-1">
            {huellaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={huellaUrl} alt="Huella del cliente" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-[11px] text-text-tertiary">Sin huella</span>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT_IMAGEN}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void subirHuella(f);
            }}
          />
          <Button
            variant="secondary"
            className="mt-1.5 w-full !py-1 !text-[11px]"
            disabled={subiendo}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="upload" size={13} /> {subiendo ? "Subiendo…" : estado?.huella ? "Reemplazar" : "Subir huella"}
          </Button>
        </div>
      </div>

      {estado?.firma?.at && (
        <p className="mt-2 text-[11px] text-text-tertiary">
          Firmado el {fmtDate(estado.firma.at)}
          {estado.firma.by ? ` · capturada por ${estado.firma.by}` : ""}
        </p>
      )}

      <FirmaModal
        open={firmando}
        onClose={() => setFirmando(false)}
        subscriberId={subscriberId}
        nombre={nombre}
        onSaved={cargar}
      />
    </div>
  );
}
