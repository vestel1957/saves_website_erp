"use client";

import { useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { TabStrip } from "@/components/ui/TabStrip";
import { SIN_FILTROS, type Filtros } from "@/components/soporte/agenda/comun";
import { VistaRepartir } from "@/components/soporte/agenda/VistaRepartir";
import { VistaPorTecnico } from "@/components/soporte/agenda/VistaPorTecnico";

type Vista = "repartir" | "tecnicos";

const VISTAS = [
  { key: "repartir" as const, label: "Repartir", icon: "list-checks" },
  { key: "tecnicos" as const, label: "Por técnico", icon: "hard-hat" },
];

/**
 * Agendamiento de órdenes de trabajo.
 *
 * Quien agenda es la CAJERA: reparte el trabajo entre los técnicos y decide en qué
 * orden va cada visita. El técnico no arma su agenda, la sigue — por eso esta
 * pantalla no está en su perfil y `AgendaService.mover` se lo vuelve a negar aunque
 * llegue por API.
 *
 * DOS PESTAÑAS, que son los dos momentos del trabajo (2026-09-02, a pedido del
 * usuario; sustituyen a los tableros de arrastre de Día, Semana y Mes):
 *
 *  · **Repartir** — la lista de órdenes sin día. Cada renglón lleva los dos datos que
 *    faltan, en dos desplegables: a QUIÉN va y QUÉ DÍA. Es la pantalla en la que se
 *    trabaja.
 *  · **Por técnico** — cómo quedó cada agenda: sus días y, dentro de cada día, sus
 *    visitas EN EL ORDEN en que las va a hacer. Es la pantalla en la que se comprueba
 *    (y se corrige el recorrido, sin volver a la otra).
 *
 * Por qué se fue el tablero de columnas: respondía "qué tan cargado va cada uno",
 * pero el trabajo de la ventanilla es coger una orden y decir quién y cuándo. En el
 * tablero eso costaba un arrastre (el quién) más navegar a otro día antes de arrastrar
 * (el cuándo): dos gestos en dos sitios para una sola decisión, y ninguno posible con
 * el dedo en la tableta. La carga por técnico no se perdió — va como cifra en las dos
 * pestañas.
 *
 * El día enfocado y los filtros viven AQUÍ y no en cada vista: pasar a comprobar
 * cómo quedó el jueves tiene que seguir enseñando el jueves —y la misma búsqueda—, o
 * cambiar de pestaña se vuelve empezar de cero.
 */
export default function AgendaPage() {
  const [vista, setVista] = useState<Vista>("repartir");
  // `null` = hoy, y lo resuelve el backend (que es quien sabe qué día es en Colombia).
  const [fecha, setFecha] = useState<string | null>(null);
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);

  const props = { fecha, setFecha, filtros, setFiltros };

  return (
    <div className="flex flex-col gap-3">
      <PageHeading
        icon="calendar-clock"
        title="Agendamiento"
        subtitle="Reparte el trabajo entre los técnicos, para hoy o para los días que vienen"
      />

      <TabStrip tabs={VISTAS} active={vista} onChange={setVista} />

      {vista === "repartir" && <VistaRepartir {...props} />}
      {vista === "tecnicos" && <VistaPorTecnico {...props} />}
    </div>
  );
}
