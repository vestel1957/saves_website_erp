"use client";

import { cloneElement, isValidElement, useId } from "react";
import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";

/** Estilo base compartido por todos los controles de formulario. */
const control =
  "w-full rounded-lg border border-border-default bg-surface px-3 py-2 text-[13px] text-text-primary shadow-sm outline-none transition-colors placeholder:text-text-tertiary hover:border-border-strong focus:border-border-focus focus:ring-2 focus:ring-brand/25 aria-[invalid=true]:border-error aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-error/20";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  // Un `type="number"` ENFOCADO suma o resta con la rueda del ratón (paso 1). En el
  // modal de recaudo —monto autoenfocado arriba y el resto del formulario más abajo—
  // bastaba con desplazarse por encima del campo para cobrar un peso de menos: el
  // recaudo entraba por 76.999 de 77.000 y la factura quedaba PARTIAL debiendo $1.
  // Al desplazar se suelta el foco: la página sigue bajando y el valor no se mueve.
  const onWheel: InputHTMLAttributes<HTMLInputElement>["onWheel"] =
    props.type === "number"
      ? (e) => { e.currentTarget.blur(); props.onWheel?.(e); }
      : props.onWheel;
  return <input className={`${control} ${className}`} {...props} onWheel={onWheel} />;
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

/** Props que este envoltorio inyecta en el control que envuelve. */
type PropsInyectadas = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

/**
 * Envoltorio de campo: etiqueta + control + ayuda/error.
 * Unifica el patrón `label + input + hint` que se repetía en cada formulario.
 *
 * ACCESIBILIDAD — la razón de que esto no sea un simple `<div>`: la etiqueta se
 * asocia al control con `htmlFor`/`id`. Sin eso, un lector de pantalla anuncia el
 * campo sin decir qué es, y pulsar la etiqueta no enfoca el control. En todo el
 * frontend no había NI UN `htmlFor` para 76 `<label>`, y el defecto estaba
 * justamente aquí: arreglarlo en este componente asocia los 385 usos de golpe.
 *
 * El id se genera con `useId` salvo que el control ya traiga uno propio. La ayuda y
 * el error se enlazan con `aria-describedby` para que también se lean, y un campo
 * con error queda marcado `aria-invalid`.
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
  const generado = useId();
  const elemento = isValidElement(children) ? (children as ReactElement<PropsInyectadas>) : null;
  const id = elemento?.props?.id ?? generado;
  const idDescripcion = error || hint ? `${id}-desc` : undefined;

  // Sólo se puede inyectar en un elemento React. Si `children` es un fragmento o
  // texto suelto, se pinta tal cual y el campo queda como estaba: mejor eso que
  // reventar por un caso no contemplado.
  const controlado = elemento
    ? cloneElement(elemento, {
        id,
        "aria-describedby":
          [elemento.props["aria-describedby"], idDescripcion].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : elemento.props["aria-invalid"],
      })
    : children;

  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1 block text-[11px] font-semibold text-text-tertiary">
          {label}
          {/* El asterisco va en rojo y desde el principio: que el campo es obligatorio
              se tiene que ver ANTES de intentar avanzar, no descubrirlo en el error. */}
          {required && (
            <>
              <span aria-hidden="true" className="ml-0.5 text-error">*</span>
              <span className="sr-only"> (obligatorio)</span>
            </>
          )}
        </label>
      )}
      {controlado}
      {error ? (
        <span id={idDescripcion} className="mt-1 block text-[11px] text-error-text">
          {error}
        </span>
      ) : hint ? (
        <span id={idDescripcion} className="mt-1 block text-[11px] text-text-tertiary">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
