"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

/**
 * Lienzo para capturar una firma dibujada (mouse o táctil). Emite el PNG como
 * data URL vía onChange cuando el trazo cambia. Botón para limpiar.
 */
export function SignaturePad({ onChange, height = 160 }: { onChange: (dataUrl: string | null) => void; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (ctx) { ctx.scale(ratio, ratio); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#111827"; }
  }, [height]);

  function pos(e: React.PointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function start(e: React.PointerEvent) { drawing.current = true; last.current = pos(e); (e.target as Element).setPointerCapture?.(e.pointerId); }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const p = pos(e);
    if (ctx && last.current) { ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    last.current = p;
    if (!dirty) setDirty(true);
  }
  function end() {
    drawing.current = false; last.current = null;
    if (dirty && canvasRef.current) onChange(canvasRef.current.toDataURL("image/png"));
  }
  function clear() {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setDirty(false); onChange(null);
  }

  return (
    <div className="w-full">
      <div className="relative rounded-lg border border-dashed border-border-default bg-surface-2">
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height, touchAction: "none" }}
          className="rounded-lg"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
        />
        {!dirty && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-text-tertiary">Firme aquí</span>}
      </div>
      <button type="button" onClick={clear} className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-tertiary hover:text-error-text">
        <Icon name="x" size={12} /> Limpiar firma
      </button>
    </div>
  );
}
