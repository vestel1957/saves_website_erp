"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/**
 * Captura de la firma del cliente sobre el lienzo.
 *
 * Se dibuja con eventos de puntero (no de ratón) porque quien firma lo hace con el
 * dedo o un lápiz sobre la tableta del técnico, no con el mouse. El lienzo se
 * escala por `devicePixelRatio`: sin eso el trazo sale pixelado en el móvil, que es
 * justo donde se usa.
 *
 * Se guarda como PNG con fondo TRANSPARENTE a propósito: la firma entra dentro del
 * PDF del contrato, y un rectángulo blanco taparía el recuadro sobre el que va.
 */
export function FirmaModal({
  open,
  onClose,
  subscriberId,
  nombre,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  subscriberId: string;
  nombre?: string | null;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const canvas = useRef<HTMLCanvasElement>(null);
  const dibujando = useRef(false);
  const [hayTrazo, setHayTrazo] = useState(false);
  const [guardando, setGuardando] = useState(false);

  // Ajuste del lienzo al abrir (y a la rotación del móvil).
  useEffect(() => {
    if (!open) return;
    const ajustar = () => {
      const el = canvas.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      el.width = Math.round(r.width * dpr);
      el.height = Math.round(r.height * dpr);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#111827";
    };
    // Un tick para que el modal ya tenga tamaño cuando se mide.
    const t = setTimeout(ajustar, 30);
    window.addEventListener("resize", ajustar);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", ajustar);
    };
  }, [open]);

  useEffect(() => {
    if (open) setHayTrazo(false);
  }, [open]);

  const punto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function inicio(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dibujando.current = true;
    const { x, y } = punto(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    // Un toque sin arrastre también es un trazo (el punto de una firma corta).
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
    setHayTrazo(true);
  }

  function mover(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dibujando.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = punto(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function fin() {
    dibujando.current = false;
  }

  function limpiar() {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.restore();
    setHayTrazo(false);
  }

  async function guardar() {
    const el = canvas.current;
    if (!el || !hayTrazo) return;
    setGuardando(true);
    try {
      const res = await authFetch(`/subscribers/${subscriberId}/firma`, {
        method: "POST",
        body: JSON.stringify({ dataUrl: el.toDataURL("image/png") }),
      });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message ?? "No se pudo guardar la firma");
      }
      toast("Firma guardada");
      onSaved();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo guardar la firma", "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Firma del contrato" maxWidth="max-w-2xl">
      <p className="mb-2 text-[12px] text-text-tertiary">
        {nombre ? `Firma de ${nombre}. ` : ""}
        Firme dentro del recuadro con el dedo o el lápiz. Queda en el contrato y en el anexo.
      </p>

      <div className="rounded-xl border border-border-subtle bg-surface-2/30 p-2">
        <canvas
          ref={canvas}
          onPointerDown={inicio}
          onPointerMove={mover}
          onPointerUp={fin}
          onPointerLeave={fin}
          onPointerCancel={fin}
          // `touch-none` es imprescindible: sin él, arrastrar el dedo hace scroll de
          // la página en vez de dibujar y no se puede firmar en el móvil.
          className="h-52 w-full touch-none rounded-lg border border-dashed border-border-subtle bg-surface"
        />
        <div className="mt-1 border-t border-border-subtle pt-1 text-center text-[11px] text-text-tertiary">
          Firma del suscriptor
        </div>
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={limpiar} disabled={!hayTrazo || guardando}>
          <Icon name="x" size={15} /> Borrar
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={guardando}>
          Cancelar
        </Button>
        <Button onClick={() => void guardar()} disabled={!hayTrazo || guardando}>
          <Icon name="check" size={15} /> {guardando ? "Guardando…" : "Guardar firma"}
        </Button>
      </div>
    </Modal>
  );
}
