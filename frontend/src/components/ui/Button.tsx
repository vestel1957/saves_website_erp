import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";

// `min-h-8` en el tamaño pequeño: con solo `py-1.5` el botón medía 30 px de
// alto, por debajo del mínimo cómodo para el dedo. El relleno no cambia, así
// que en escritorio se ve igual.
const sizes: Record<Size, string> = {
  sm: "min-h-8 px-3 py-1.5 text-[12px]",
  md: "px-3.5 py-2 text-[13px]",
};

const variants: Record<Variant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-hover",
  secondary: "border border-border-default text-text-secondary hover:bg-surface-2",
  ghost: "text-text-secondary hover:bg-surface-2",
  danger: "border border-border-default text-error-text hover:bg-error-soft",
};

/**
 * Botón reutilizable de la app. Centraliza los estilos que antes se repetían
 * en cada página (primario de marca, secundario, fantasma, peligro).
 */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: {
  variant?: Variant;
  size?: Size;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
