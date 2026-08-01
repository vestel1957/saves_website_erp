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
    // MÓVIL PRIMERO: en pantallas angostas las pestañas conservan su ancho
    // natural y la barra se desliza (con `flex-1` las etiquetas largas —"Datos
    // personales", "Permisos y accesos"— se partían en dos renglones y la
    // píldora activa quedaba deformada). Desde `sm` sí se reparten el ancho.
    // `shrink-0` es obligatorio: al ser contenedor de scroll su `min-height`
    // pasa a valer 0, y como cuelga de un flex-col (el <main> del AppFrame) se
    // aplastaba a 8 px de alto dejando las pestañas fuera de la caja.
    <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto rounded-lg border border-border-subtle bg-surface p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-[13px] font-semibold transition-colors sm:flex-1 sm:shrink sm:py-1.5 ${
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
