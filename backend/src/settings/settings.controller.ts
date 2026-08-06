import { SettingsService } from './settings.service';
import { AuthUser } from '../auth/current-user.decorator';
import { UpdateGoalsDto, UpdateSettingsDto } from './dto/settings.dto';

/** Ajustes globales: metas de negocio, moneda, SMTP y términos de facturación. */
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  goals() { return this.settings.goals(); }
  updateGoals(body: UpdateGoalsDto, u?: AuthUser) {
    return this.settings.updateGoals(body ?? {}, u?.name ?? u?.email);
  }

  list() { return this.settings.settings(); }
  update(body: UpdateSettingsDto, u?: AuthUser) {
    return this.settings.updateSettings(body?.values ?? {}, u?.name ?? u?.email);
  }
}
