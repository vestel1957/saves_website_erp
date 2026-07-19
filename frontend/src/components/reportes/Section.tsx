/** Marco de sección con un título discreto sobre una grilla de tarjetas. */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {title && <h2 className="text-[13px] font-bold uppercase tracking-wide text-text-tertiary">{title}</h2>}
      {children}
    </div>
  );
}
