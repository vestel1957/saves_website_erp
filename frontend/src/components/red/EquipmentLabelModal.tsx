"use client";

import { useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";

export type LabelEquip = { code: number; brand?: string | null; mac?: string | null; serial?: string | null };

/** Valor que se codifica en el QR: URL que abre el equipo en el ERP al escanear. */
export function equipQrValue(code: number): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/red/equipos?q=${code}`;
}

/**
 * Etiqueta física del equipo (sticker con QR). Se usa estilo inline para que
 * la ventana de impresión la renderice idéntica sin cargar el CSS de la app.
 * El sticker mide ~50×30 mm (formato de rótulo de activo común).
 */
function Sticker({ equip }: { equip: LabelEquip }) {
  const value = equipQrValue(equip.code);
  return (
    <div
      className="eq-sticker"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "62mm",
        padding: "3mm",
        border: "1px solid #cbd5e1",
        borderRadius: "6px",
        background: "#ffffff",
        boxSizing: "border-box",
        breakInside: "avoid",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        color: "#0d1526",
      }}
    >
      <QRCodeSVG value={value} size={104} level="M" marginSize={0} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "1px", lineHeight: 1.15 }}>
        <span style={{ fontSize: "8px", letterSpacing: "1px", color: "#586576", fontWeight: 700 }}>VESTEL · EQUIPO</span>
        <span style={{ fontSize: "20px", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>#{equip.code}</span>
        {equip.brand ? <span style={{ fontSize: "10px", fontWeight: 600 }}>{equip.brand}</span> : null}
        {equip.mac ? <span style={{ fontSize: "9px", color: "#45525f", fontFamily: "ui-monospace, monospace" }}>MAC {equip.mac}</span> : null}
        {equip.serial ? <span style={{ fontSize: "9px", color: "#586576", fontFamily: "ui-monospace, monospace" }}>S/N {equip.serial}</span> : null}
      </div>
    </div>
  );
}

/** Abre una ventana de impresión con N copias del sticker. */
function printStickers(stickerHtml: string, copies: number) {
  const w = window.open("", "_blank", "width=480,height=360");
  if (!w) return;
  const sheet = Array.from({ length: Math.max(1, copies) }, () => stickerHtml).join("");
  w.document.write(
    `<!doctype html><html><head><title>Etiquetas de equipo</title>` +
      `<style>@page{margin:6mm} body{margin:0} .sheet{display:flex;flex-wrap:wrap;gap:4mm;padding:4mm}</style>` +
      `</head><body><div class="sheet">${sheet}</div>` +
      `<script>window.onload=function(){setTimeout(function(){window.print();window.close();},200)}<\/script>` +
      `</body></html>`,
  );
  w.document.close();
}

export function EquipmentLabelModal({
  open,
  onClose,
  equip,
  title = "Etiqueta del equipo",
}: {
  open: boolean;
  onClose: () => void;
  equip: LabelEquip | null;
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(1);
  const value = useMemo(() => (equip ? equipQrValue(equip.code) : ""), [equip]);

  if (!equip) return null;

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-md">
      <div className="flex flex-col items-center gap-4">
        <p className="text-center text-[12px] text-text-tertiary">
          Escanea el QR para abrir el equipo en el sistema. Imprime en sticker y pégalo en el equipo.
        </p>

        {/* Vista previa del sticker (misma marca que la impresión) */}
        <div ref={ref}>
          <Sticker equip={equip} />
        </div>

        <p className="break-all text-center text-[10px] text-text-tertiary">{value}</p>

        <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            Copias
            <select
              value={copies}
              onChange={(e) => setCopies(Number(e.target.value))}
              className="rounded-lg border border-border-default bg-surface px-2 py-1.5 text-[12px]"
            >
              {[1, 2, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cerrar</Button>
            <Button onClick={() => ref.current && printStickers(ref.current.innerHTML, copies)}>
              <Icon name="download" size={14} /> Imprimir
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
