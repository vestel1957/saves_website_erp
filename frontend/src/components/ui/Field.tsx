import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from "react";

/** Estilo base compartido por todos los controles de formulario. */
const control =
  "w-full rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px] text-text-primary shadow-sm outline-none transition-colors placeholder:text-text-tertiary hover:border-border-strong focus:border-border-focus focus:ring-2 focus:ring-brand/25";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${control} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative ${className}`}>
      <select className={`${control} cursor-pointer appearance-none pr-9 font-medium`} {...props} />
      {/* flecha personalizada (los <select> nativos se ven flojos) */}
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${control} ${className}`} {...props} />;
}

/**
 * Envoltorio de campo: etiqueta + control + ayuda/error.
 * Unifica el patrón `label + input + hint` que se repetía en cada formulario.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      {label && (
        <label className="mb-1 block text-[11px] font-semibold text-text-tertiary">
          {label}
          {required && " *"}
        </label>
      )}
      {children}
      {error ? (
        <span className="mt-1 block text-[11px] text-error-text">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-text-tertiary">{hint}</span>
      ) : null}
    </div>
  );
}
