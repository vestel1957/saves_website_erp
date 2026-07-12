"use client";

export type Tab<K extends string> = { key: K; label: string };

/** Barra de pestañas reutilizable para fusionar varias vistas en una sola página. */
export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-border-subtle bg-surface p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-colors ${
            active === t.key
              ? "bg-surface-2 text-text-primary"
              : "text-text-tertiary hover:text-text-secondary"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
