"use client";

/**
 * Control segmentado: dos o tres opciones excluyentes siempre visibles.
 *
 * Sirve donde un `<select>` obliga a abrir una lista para descubrir qué hay dentro y
 * las opciones son pocas y cortas. En promociones reemplazó un desplegable de cuatro
 * opciones que mezclaba dos decisiones distintas (porcentaje o monto / antes o después
 * de impuestos): partido en dos controles, cada uno enseña sus alternativas de golpe.
 *
 * ACCESIBILIDAD: es un grupo de botones con `aria-pressed`, no un radiogroup, porque
 * cada opción se elige con un clic o con Enter y no hace falta navegar con flechas.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex rounded-lg border border-border-subtle bg-surface-2 p-0.5 ${className}`}
    >
      {options.map((o) => {
        const activo = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={activo}
            onClick={() => onChange(o.value)}
            className={`tap flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
              activo
                ? "bg-surface text-brand shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Interruptor de encendido/apagado con su explicación al lado.
 * Reemplaza al `<input type="checkbox">` pelado allí donde el estado cambia lo que
 * el sistema HACE (una promoción activa descuenta plata; una inactiva no).
 */
export function Interruptor({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="tap flex w-full items-start gap-2.5 rounded-lg text-left"
    >
      <span
        aria-hidden
        className={`mt-0.5 h-[21px] w-[38px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-brand" : "bg-border-strong"
        }`}
      >
        <span
          className={`block h-[17px] w-[17px] translate-y-[2px] rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[19px]" : "translate-x-[2px]"
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-text-primary">{title}</span>
        <span className="block text-[11.5px] text-text-tertiary">{detail}</span>
      </span>
    </button>
  );
}

/**
 * El mismo interruptor sin texto, para cuando va dentro de una fila de lista y
 * lo que enciende ya lo dice la fila (el plan que tiene al lado, por ejemplo).
 * `label` no se ve: es lo que lee el lector de pantalla.
 */
export function InterruptorCompacto({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="tap shrink-0 rounded-full disabled:opacity-50"
    >
      <span
        aria-hidden
        className={`block h-[21px] w-[38px] rounded-full transition-colors ${
          checked ? "bg-brand" : "bg-border-strong"
        }`}
      >
        <span
          className={`block h-[17px] w-[17px] translate-y-[2px] rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[19px]" : "translate-x-[2px]"
          }`}
        />
      </span>
    </button>
  );
}
