/**
 * Lightweight report export — no server-side or heavy client deps.
 *  - PDF  → opens a print-ready window (user prints / saves as PDF).
 *  - Excel → downloads an HTML-table `.xls` (opens natively in Excel, keeps
 *            accents via UTF-8 and numbers as real numeric cells).
 */
import { fullCurrency } from "./format";

export type Align = "left" | "right";
export interface ReportColumn {
  label: string;
  align?: Align;
  /** Render the cell as currency (PDF) / numeric cell (Excel). */
  money?: boolean;
}
export interface ReportRow {
  cells: (string | number)[];
  bold?: boolean;
}
export interface ReportTable {
  heading?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
}
export interface ReportDoc {
  title: string;
  subtitle?: string;
  tables: ReportTable[];
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function issuedDate() {
  return new Date().toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });
}

/** Build the inner <table> markup. `mode` decides number rendering. */
function tablesHtml(doc: ReportDoc, mode: "pdf" | "xls"): string {
  return doc.tables
    .map((t) => {
      const head = t.columns
        .map((c) => `<th class="${c.align === "right" ? "num" : ""}">${esc(c.label)}</th>`)
        .join("");
      const body = t.rows
        .map((r) => {
          const tds = r.cells
            .map((cell, i) => {
              const col = t.columns[i];
              const right = col?.align === "right";
              let content: string;
              if (typeof cell === "number" && col?.money) {
                content = mode === "pdf" ? esc(fullCurrency(cell)) : String(Math.round(cell * 100) / 100);
              } else {
                content = esc(cell);
              }
              return `<td class="${right ? "num" : ""}${r.bold ? " b" : ""}">${content}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      return `${t.heading ? `<h3>${esc(t.heading)}</h3>` : ""}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    })
    .join("");
}

export function exportReportPDF(doc: ReportDoc) {
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) return;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<title>${esc(doc.title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color:#1a1a1a; margin:0; padding:32px; font-size:13px; }
  .sheet { max-width:760px; margin:0 auto; }
  h1 { font-size:18px; margin:0 0 2px; }
  .sub { color:#666; margin:0 0 4px; }
  .issued { color:#888; font-size:11px; margin:0 0 18px; }
  h3 { font-size:13px; margin:18px 0 6px; text-transform:uppercase; letter-spacing:.4px; color:#444; }
  table { width:100%; border-collapse:collapse; margin-bottom:8px; }
  th,td { padding:7px 10px; border-bottom:1px solid #e3e3e3; text-align:left; }
  th { background:#f5f5f5; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .b { font-weight:bold; }
  .foot { margin-top:24px; color:#888; font-size:11px; text-align:center; }
  .toolbar { text-align:center; margin-bottom:18px; }
  .toolbar button { font-size:13px; padding:8px 18px; border:0; border-radius:6px; background:#1a1a1a; color:#fff; cursor:pointer; }
  @media print { .toolbar { display:none; } body { padding:0; } }
</style></head><body><div class="sheet">
  <div class="toolbar"><button onclick="window.print()">Imprimir / Guardar PDF</button></div>
  <h1>${esc(doc.title)}</h1>
  ${doc.subtitle ? `<p class="sub">${esc(doc.subtitle)}</p>` : ""}
  <p class="issued">Generado el ${issuedDate()} · Vestel</p>
  ${tablesHtml(doc, "pdf")}
  <p class="foot">Documento generado por Vestel.</p>
</div></body></html>`;
  win.document.write(html);
  win.document.close();
}

export function exportReportExcel(doc: ReportDoc) {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"/>
<style>th{background:#f0f0f0;font-weight:bold;} .num{mso-number-format:"\\#\\,\\#\\#0";text-align:right;} .b{font-weight:bold;}</style>
</head><body>
<h2>${esc(doc.title)}</h2>${doc.subtitle ? `<p>${esc(doc.subtitle)}</p>` : ""}
${tablesHtml(doc, "xls")}
</body></html>`;
  const blob = new Blob(["﻿", html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(doc.title)}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
