"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Dropdown } from "./ui/Dropdown";
import {
  applyBrandColor,
  BRAND_PRESETS,
  contrastRatio,
  DEFAULT_BRAND,
  isValidHex,
  normalizeHex,
  onBrandColor,
  readStoredBrand,
} from "@/lib/brand";

/**
 * Selector de color primario. Escribe --color-brand / --color-on-brand en <html>
 * y persiste la elección por usuario en localStorage. Todos los tonos derivados
 * (hover, soft, sidebar-active) salen de color-mix() en globals.css.
 */
export function BrandColorPicker() {
  const [color, setColor] = useState(DEFAULT_BRAND);
  const [draft, setDraft] = useState(DEFAULT_BRAND); // texto del input hex mientras se escribe
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const c = readStoredBrand();
    setColor(c);
    setDraft(c.toUpperCase());
    setMounted(true);
  }, []);

  function choose(hex: string) {
    if (!isValidHex(hex)) return;
    const c = normalizeHex(hex);
    setColor(c);
    setDraft(c.toUpperCase());
    applyBrandColor(c);
  }

  // Contraste del texto sobre la marca (para el aviso de accesibilidad).
  const onBrand = onBrandColor(color);
  const ratio = contrastRatio(color, onBrand);
  const level = ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA grande" : "bajo";
  const levelOk = ratio >= 4.5;

  return (
    <Dropdown
      align="right"
      width={272}
      trigger={
        <span
          aria-label="Cambiar color primario"
          title="Color primario"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-text-secondary transition-colors hover:bg-border-subtle"
        >
          <Icon name="palette" size={16} />
        </span>
      }
    >
      {() => (
        <div className="p-2">
          <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            Color primario
          </p>

          {/* selector libre + hex */}
          <div className="flex items-center gap-2 px-1">
            <label className="relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border-default">
              <span
                className="block h-full w-full"
                style={{ background: color }}
              />
              <input
                type="color"
                value={mounted ? color : DEFAULT_BRAND}
                onChange={(e) => choose(e.target.value)}
                aria-label="Elegir color primario"
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <input
              type="text"
              value={draft}
              spellCheck={false}
              maxLength={7}
              onChange={(e) => {
                setDraft(e.target.value);
                if (isValidHex(e.target.value)) choose(e.target.value);
              }}
              aria-label="Código hexadecimal"
              className="w-full rounded-lg border border-border-default bg-surface px-2.5 py-2 font-mono text-[13px] uppercase text-text-primary outline-none focus:border-border-focus focus:ring-2 focus:ring-brand/30"
            />
          </div>

          {/* aviso de contraste en vivo */}
          <div className="mt-2 flex items-center justify-between px-1 text-[11px]">
            <span className="text-text-tertiary">Texto sobre la marca</span>
            <span
              className={`rounded-full px-2 py-0.5 font-semibold ${
                levelOk
                  ? "bg-success-soft text-success-text"
                  : "bg-warning-soft text-warning-text"
              }`}
            >
              {ratio.toFixed(1)}:1 · {level}
            </span>
          </div>

          {/* presets */}
          <p className="px-1 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            Presets
          </p>
          <div className="grid grid-cols-8 gap-1.5 px-1 pb-1">
            {BRAND_PRESETS.map((p) => {
              const active = normalizeHex(p.hex) === color;
              return (
                <button
                  key={p.hex}
                  type="button"
                  onClick={() => choose(p.hex)}
                  title={p.name}
                  aria-label={p.name}
                  aria-pressed={active}
                  className={`h-6 w-6 rounded-md transition-transform hover:scale-110 ${
                    active ? "ring-2 ring-text-primary ring-offset-2 ring-offset-surface" : ""
                  }`}
                  style={{ background: p.hex }}
                />
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => choose(DEFAULT_BRAND)}
            className="mt-2 w-full rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
          >
            Restablecer al color por defecto
          </button>
        </div>
      )}
    </Dropdown>
  );
}
