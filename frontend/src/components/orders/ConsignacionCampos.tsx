"use client";

import { Input, Select, Field } from "@/components/ui/Field";

/** Datos de la consignación de una orden de compra: a qué cuenta se le paga al proveedor. */
export type Consignacion = { payBank: string; payAccountType: string; payAccount: string; payHolder: string; payHolderDoc: string };

export const consignacionVacia = (): Consignacion => ({ payBank: "", payAccountType: "", payAccount: "", payHolder: "", payHolderDoc: "" });

/** Los tipos que usan los proveedores (legacy `supplier.typo`). */
const TIPOS_CUENTA = ["Ahorros", "Corriente"];

export function ConsignacionCampos({ value, onChange }: { value: Consignacion; onChange: (v: Consignacion) => void }) {
  const set = (patch: Partial<Consignacion>) => onChange({ ...value, ...patch });
  // Un tipo raro que viniera del legacy no se pierde al abrir el formulario.
  const tipos = value.payAccountType && !TIPOS_CUENTA.includes(value.payAccountType) ? [...TIPOS_CUENTA, value.payAccountType] : TIPOS_CUENTA;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label="Banco">
        <Input value={value.payBank} onChange={(e) => set({ payBank: e.target.value })} placeholder="Bancolombia, Davivienda…" />
      </Field>
      <Field label="Tipo de cuenta">
        <Select value={value.payAccountType} onChange={(e) => set({ payAccountType: e.target.value })}>
          <option value="">Sin indicar</option>
          {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </Field>
      <Field label="Número de cuenta">
        <Input inputMode="numeric" value={value.payAccount} onChange={(e) => set({ payAccount: e.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Titular de la cuenta">
          <Input value={value.payHolder} onChange={(e) => set({ payHolder: e.target.value })} />
        </Field>
      </div>
      <Field label="NIT / C.C. del titular">
        <Input value={value.payHolderDoc} onChange={(e) => set({ payHolderDoc: e.target.value })} />
      </Field>
    </div>
  );
}
