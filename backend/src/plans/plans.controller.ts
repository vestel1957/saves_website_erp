import { ServiceKind } from '@prisma/client';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

/** Catálogo de planes de servicio (internet/TV). */
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  list(activeOnly?: string, kind?: ServiceKind) {
    return this.plans.list({ activeOnly: activeOnly === 'true', kind });
  }

  // El catálogo lo LEE todo el mundo (los selectores de plan están por todo el ERP),
  // pero escribirlo es tocar el PRECIO con el que se le factura a 21k abonados. Se
  // cierra a quien tiene la pantalla que lo edita —`/configuracion/planes`, de
  // sistemas— más administración (2026-08-03). Antes lo heredaba el @RequireArea de
  // la clase y podía cambiar una tarifa cualquiera del área caja o técnicos.

  create(dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  update(id: string, dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  remove(id: string) {
    return this.plans.remove(id);
  }
}
