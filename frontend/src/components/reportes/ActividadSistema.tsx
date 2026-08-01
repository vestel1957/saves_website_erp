import { ChartCard, HBarList, TrendStat } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { Icon } from "@/components/Icon";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";

const fechaHora = (d: string) =>
  new Date(d).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function ActividadSistema({ data }: { data: any }) {
  const porUsuario = data.porUsuario ?? [];
  const porModulo = data.porModulo ?? [];
  const porOperacion = data.porOperacion ?? [];
  const eventos = data.eventos ?? [];
  const personas = porUsuario.filter((u: any) => u.userId);

  return (
    <>
      {/* La advertencia va primero porque sin ella este reporte se lee como
          "productividad del equipo", y no lo es ni de lejos. */}
      <div className="rounded-xl border border-warning-border bg-warning-soft p-3 text-[12px] leading-relaxed text-warning-text">
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <Icon name="alert-triangle" size={14} /> Esto NO mide productividad
        </div>
        La bitácora solo registra algunas operaciones (logins, cambios de configuración, acciones de red,
        cierres de órdenes). Alguien que trabajó todo el día atendiendo clientes puede aparecer con cero
        eventos. Sirve para <strong>rastrear qué se tocó y quién lo tocó</strong>, no para comparar personas.
      </div>

      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <TrendStat label="Eventos registrados" value={nfmt(data.total ?? 0)} icon="history"
            hint={data.truncado ? "Se alcanzó el tope: hay más sin contar" : "En el periodo seleccionado"}
            tone={data.truncado ? "warning" : "default"} />
          <TrendStat label="Usuarios con actividad" value={nfmt(personas.length)} icon="contact"
            hint="Sin contar los eventos automáticos" />
          <TrendStat label="Módulos tocados" value={nfmt(porModulo.length)} icon="layers" />
          <TrendStat label="Operación más frecuente" value={porOperacion[0]?.operacion?.split(" ").pop() ?? "—"} icon="repeat"
            hint={porOperacion[0] ? `${nfmt(porOperacion[0].eventos)} veces` : ""} />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Eventos por usuario" subtitle="Incluye los automáticos del sistema" icon="contact">
          <HBarList rows={porUsuario.slice(0, 12).map((u: any) => ({ label: u.nombre, value: u.eventos }))} />
        </ChartCard>
        <ChartCard title="Eventos por módulo" subtitle="Qué parte del sistema se usa" icon="layers">
          <HBarList monochrome rows={porModulo.slice(0, 12).map((m: any) => ({ label: m.modulo, value: m.eventos }))} />
        </ChartCard>
      </div>

      <ChartCard title="Operaciones más frecuentes" subtitle="Con los identificadores reemplazados por :id para poder agrupar" icon="list">
        <HBarList monochrome accent="var(--color-ai)"
          rows={porOperacion.slice(0, 12).map((o: any) => ({ label: o.operacion, value: o.eventos }))} />
      </ChartCard>

      <ChartCard title="Últimos eventos" subtitle="Los 300 más recientes del periodo" icon="list-tree">
        <DataTable rows={eventos} empty="Sin actividad registrada en este periodo." columns={[
          { key: "f", header: "Cuándo", render: (r: any) => fechaHora(r.fecha) },
          { key: "u", header: "Quién", render: (r: any) => (
            <span className={r.usuario === "Sistema (automático)" ? "text-text-tertiary italic" : "font-medium text-text-primary"}>{r.usuario}</span>
          ) },
          { key: "m", header: "Módulo", render: (r: any) => <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-secondary">{r.modulo}</span> },
          { key: "o", header: "Operación", render: (r: any) => <span className="font-mono text-[11px] text-text-secondary">{r.operacion}</span> },
          { key: "ip", header: "IP", render: (r: any) => <span className="font-mono text-[11px] text-text-tertiary">{r.ip ?? "—"}</span> },
        ]} />
      </ChartCard>
    </>
  );
}
