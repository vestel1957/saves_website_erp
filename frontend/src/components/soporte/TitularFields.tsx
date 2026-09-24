"use client";

import { Field, Input, Select } from "@/components/ui/Field";
import { CUSTOMER_TYPES, DOC_TYPES } from "@/lib/subscribers";

/**
 * Los datos del NUEVO TITULAR de una orden 'Cambio de titular'. Son las columnas de
 * la ficha que dicen quién es el cliente; el backend las valida igual
 * (`common/cambio-titular.ts`) y las escribe en la ficha al guardar la orden.
 */
export type TitularValor = {
  customerType: string;
  firstName: string;
  secondName: string;
  lastName1: string;
  lastName2: string;
  companyName: string;
  docType: string;
  docNumber: string;
  phone1: string;
  phone2: string;
  email: string;
};

export const TITULAR_VACIO: TitularValor = {
  customerType: "Natural", firstName: "", secondName: "", lastName1: "", lastName2: "",
  companyName: "", docType: "CC", docNumber: "", phone1: "", phone2: "", email: "",
};

/** Arranca desde lo que la orden ya tiene registrado (`cambioTitular.datos`). */
export function titularDesde(d: Record<string, unknown> | null | undefined): TitularValor {
  if (!d) return TITULAR_VACIO;
  const s = (k: keyof TitularValor) => (d[k] == null ? TITULAR_VACIO[k] : String(d[k]));
  return Object.fromEntries(Object.keys(TITULAR_VACIO).map((k) => [k, s(k as keyof TitularValor)])) as TitularValor;
}

/** Lo que falta para poder guardar, o null si está completo. */
export function faltaEnTitular(v: TitularValor): string | null {
  if (v.customerType === "Natural") {
    if (!v.firstName.trim() || !v.lastName1.trim()) return "Escribe el nombre y el primer apellido del nuevo titular.";
  } else if (!v.companyName.trim()) {
    return "Escribe la razón social del nuevo titular.";
  }
  if (!v.docNumber.trim()) return "Escribe el número de documento del nuevo titular.";
  if (v.phone1.replace(/\D/g, "").length < 7) return "Escribe un celular del nuevo titular.";
  if (v.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return "El correo del nuevo titular no es válido.";
  return null;
}

/** El cuerpo que espera el backend (`newHolder`): lo vacío no viaja. */
export function titularPayload(v: TitularValor) {
  const natural = v.customerType === "Natural";
  const out: Record<string, string> = { customerType: v.customerType, docType: v.docType, docNumber: v.docNumber.trim(), phone1: v.phone1.trim() };
  const opc: (keyof TitularValor)[] = natural
    ? ["firstName", "secondName", "lastName1", "lastName2", "phone2", "email"]
    : ["companyName", "phone2", "email"];
  for (const k of opc) if (v[k].trim()) out[k] = v[k].trim();
  return out;
}

/** 'Pedro Gómez · CC 123', como lo arma el backend, para enseñarlo antes de guardar. */
export function titularTexto(v: TitularValor): string {
  const nombre = v.customerType === "Natural"
    ? [v.firstName, v.secondName, v.lastName1, v.lastName2].map((x) => x.trim()).filter(Boolean).join(" ")
    : v.companyName.trim();
  const doc = v.docNumber.trim() ? `${v.docType} ${v.docNumber.replace(/[\s.]/g, "")}` : "";
  return [nombre, doc].filter(Boolean).join(" · ");
}

export function TitularFields({ value, onChange }: { value: TitularValor; onChange: (patch: Partial<TitularValor>) => void }) {
  const natural = value.customerType === "Natural";
  const set = (k: keyof TitularValor) => (e: { target: { value: string } }) => onChange({ [k]: e.target.value });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Tipo de cliente" required>
        <Select value={value.customerType} onChange={set("customerType")}>
          {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      {natural ? (
        <>
          <div className="hidden sm:block" />
          <Field label="Primer nombre" required>
            <Input value={value.firstName} onChange={set("firstName")} autoComplete="off" />
          </Field>
          <Field label="Segundo nombre">
            <Input value={value.secondName} onChange={set("secondName")} autoComplete="off" />
          </Field>
          <Field label="Primer apellido" required>
            <Input value={value.lastName1} onChange={set("lastName1")} autoComplete="off" />
          </Field>
          <Field label="Segundo apellido">
            <Input value={value.lastName2} onChange={set("lastName2")} autoComplete="off" />
          </Field>
        </>
      ) : (
        <Field label="Razón social" required>
          <Input value={value.companyName} onChange={set("companyName")} autoComplete="off" />
        </Field>
      )}
      <Field label="Tipo de documento" required>
        <Select value={value.docType} onChange={set("docType")}>
          {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      <Field label="Número de documento" required>
        <Input value={value.docNumber} onChange={set("docNumber")} inputMode="numeric" autoComplete="off" />
      </Field>
      <Field label="Celular" required>
        <Input value={value.phone1} onChange={set("phone1")} inputMode="tel" autoComplete="off" />
      </Field>
      <Field label="Celular 2">
        <Input value={value.phone2} onChange={set("phone2")} inputMode="tel" autoComplete="off" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Correo">
          <Input type="email" value={value.email} onChange={set("email")} autoComplete="off" />
        </Field>
      </div>
    </div>
  );
}
