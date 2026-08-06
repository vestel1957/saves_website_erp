import { ReturnsService, CreateReturnDto, PayReturnDto } from './returns.service';
import { AuthUser } from '../auth/current-user.decorator';

/** Devoluciones de material a proveedor (stockreturn, migrado de saves-vestel). */
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  stats() { return this.returns.stats(); }
  list(search?: string, status?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.returns.list({ search, status, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  detail(id: string) { return this.returns.detail(id); }
  create(dto: CreateReturnDto, user: AuthUser) { return this.returns.create(dto, user); }
  pay(id: string, dto: PayReturnDto, user: AuthUser) { return this.returns.pay(id, dto, user); }
  remove(id: string) { return this.returns.remove(id); }
}
