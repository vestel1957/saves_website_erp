import { OmniService, CreateQuoteDto, EventDto, QuoteStatusDto, UpdateEventDto } from './omni.service';
import { AuthUser } from '../auth/current-user.decorator';

/** Omnicanalidad: agenda (eventos), cotizaciones. */
export class OmniController {
  constructor(private readonly omni: OmniService) {}

  // Los filtros van sueltos y no en un DTO porque el listado se comparte con las
  // cifras de arriba (`events/stats`), que reciben exactamente los mismos.
  events(
    search?: string,
    from?: string, to?: string,
    priority?: string, assignedBy?: string,
    page?: string, pageSize?: string,
    sortBy?: string, sortDir?: string,
  ) {
    return this.omni.events({ search, from, to, priority, assignedBy, page, pageSize, sortBy, sortDir });
  }
  eventsStats(
    search?: string,
    from?: string, to?: string,
    priority?: string, assignedBy?: string,
  ) {
    return this.omni.eventsStats({ search, from, to, priority, assignedBy });
  }
  /**
   * Los eventos que CRUZAN una ventana de días — lo que pinta la rejilla del calendario.
   *
   * Va aparte del listado a propósito: aquél pagina y filtra por el día en que el
   * evento EMPIEZA; éste devuelve la ventana entera sin paginar (con tope) y cuenta
   * también los que vienen de antes y siguen dentro. Ver `eventsCalendar`.
   */
  eventsCalendar(
    from?: string, to?: string,
    search?: string,
    priority?: string, assignedBy?: string,
  ) {
    return this.omni.eventsCalendar({ from, to, search, priority, assignedBy });
  }
  /** Opciones de los desplegables del filtro (gente que aparece, prioridades). */
  eventFilters() { return this.omni.eventFilters(); }
  createEvent(dto: EventDto, user: AuthUser) { return this.omni.createEvent(dto, user); }
  updateEvent(id: string, dto: UpdateEventDto, user: AuthUser) { return this.omni.updateEvent(id, dto, user); }
  deleteEvent(id: string, user: AuthUser) { return this.omni.deleteEvent(id, user); }
  /**
   * Los eventos de quien pregunta (los que puso y a los que lo invitaron). Sin área:
   * a un evento se invita a cualquier funcionario y tiene que poder verlo.
   */
  myEvents(from: string | undefined, to: string | undefined, user: AuthUser) { return this.omni.myEvents(from, to, user); }

  // Los EVENTOS son la agenda (`/agenda`, que sí es de la cajera) y quedan como están.
  // Las COTIZACIONES no: una cotización se convierte en FACTURA, y facturar es de
  // contabilidad desde el 2026-07-29. Sin este cierre quedaba la puerta de atrás —
  // cotizar y convertir— a un módulo cuya pantalla (`/cotizaciones`) la cajera ni ve.
  quotes(search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.omni.quotes({ search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  createQuote(dto: CreateQuoteDto, user: AuthUser) { return this.omni.createQuote(dto, user); }
  quoteDetail(id: string) { return this.omni.quoteDetail(id); }
  quoteStatus(id: string, dto: QuoteStatusDto) { return this.omni.updateQuoteStatus(id, dto.status); }
  convertQuote(id: string, user: AuthUser) { return this.omni.convertQuoteToInvoice(id, user); }
}
