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

/**
 * Dibuja el sticker en un canvas (a 4×) para copiarlo como imagen. Se pinta a
 * mano en vez de rasterizar el HTML: un SVG con foreignObject ensucia el canvas
 * y no deja exportar. El QR sí sale del SVG ya renderizado (sin foreignObject).
 */
async function stickerToPng(svg: SVGSVGElement, equip: LabelEquip): Promise<Blob> {
  const S = 4;
  const PAD = 11, QR = 104, GAP = 10;
  const sans = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const mono = "ui-monospace, Menlo, Consolas, monospace";
  const lines: { text: string; font: string; size: number; color: string; spacing?: number }[] = [
    { text: "VESTEL · EQUIPO", font: `700 8px ${sans}`, size: 8, color: "#586576", spacing: 1 },
    { text: `#${equip.code}`, font: `800 20px ${sans}`, size: 20, color: "#0d1526" },
  ];
  if (equip.brand) lines.push({ text: equip.brand, font: `600 10px ${sans}`, size: 10, color: "#0d1526" });
  if (equip.mac) lines.push({ text: `MAC ${equip.mac}`, font: `9px ${mono}`, size: 9, color: "#45525f" });
  if (equip.serial) lines.push({ text: `S/N ${equip.serial}`, font: `9px ${mono}`, size: 9, color: "#586576" });

  const measure = document.createElement("canvas").getContext("2d")!;
  const textW = Math.max(
    ...lines.map((l) => {
      measure.font = l.font;
      return measure.measureText(l.text).width + (l.spacing ?? 0) * l.text.length;
    }),
  );
  const textH = lines.reduce((h, l) => h + l.size * 1.15, 0) + (lines.length - 1);
  const W = Math.ceil(Math.max(234, PAD * 2 + QR + GAP + textW));
  const H = PAD * 2 + Math.max(QR, textH);

  const canvas = document.createElement("canvas");
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(S, S);

  // Fondo blanco con borde redondeado, igual que la vista previa
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, W - 1, H - 1, 6);
  ctx.fill();
  ctx.stroke();

  // QR desde el SVG ya pintado
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(QR * S));
  clone.setAttribute("height", String(QR * S));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, PAD, (H - QR) / 2, QR, QR);
  } finally {
    URL.revokeObjectURL(url);
  }

  // Texto, centrado verticalmente como en el flex de la vista previa
  ctx.textBaseline = "top";
  let y = (H - textH) / 2;
  const x = PAD + QR + GAP;
  for (const l of lines) {
    ctx.font = l.font;
    ctx.fillStyle = l.color;
    const off = (l.size * 1.15 - l.size) / 2;
    if (l.spacing) {
      let cx = x;
      for (const ch of l.text) { ctx.fillText(ch, cx, y + off); cx += ctx.measureText(ch).width + l.spacing; }
    } else {
      ctx.fillText(l.text, x, y + off);
    }
    y += l.size * 1.15 + 1;
  }

  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "downloaded" | "error">("idle");
  const value = useMemo(() => (equip ? equipQrValue(equip.code) : ""), [equip]);

  if (!equip) return null;

  const flash = (s: typeof copyState) => {
    setCopyState(s);
    setTimeout(() => setCopyState("idle"), 2500);
  };

  const copyImage = async () => {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;
    const png = stickerToPng(svg, equip);
    try {
      // La promesa va directo al ClipboardItem: Safari exige que write() ocurra dentro del clic
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      flash("copied");
    } catch {
      // Sin permiso de portapapeles (o navegador sin soporte): se descarga el PNG
      try {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(await png);
        a.download = `etiqueta-equipo-${equip.code}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        flash("downloaded");
      } catch {
        flash("error");
      }
    }
  };

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
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onClose}>Cerrar</Button>
            <Button variant="secondary" onClick={copyImage}>
              <Icon name={copyState === "copied" ? "check" : "copy"} size={14} />
              {copyState === "copied" ? "Copiada" : copyState === "downloaded" ? "Descargada" : copyState === "error" ? "No se pudo" : "Copiar imagen"}
            </Button>
            <Button onClick={() => ref.current && printStickers(ref.current.innerHTML, copies)}>
              <Icon name="download" size={14} /> Imprimir
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
