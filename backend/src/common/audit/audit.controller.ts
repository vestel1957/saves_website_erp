import { AuditService } from './audit.service';

/** Visor de la bitácora global (auditoría de acciones). Área Sistemas. */
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  list(
    search?: string,
    entity?: string,
    userId?: string,
    from?: string,
    to?: string,
    page?: string,
    pageSize?: string,
    sortBy?: string,
    sortDir?: string,
    ruido?: string,
  ) {
    return this.audit.list({ search, entity, userId, from, to, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir, ruido });
  }
}
