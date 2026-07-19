import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ChatbotService } from './chatbot.service';
import { ChatbotLinkService } from './chatbot-link.service';
import { ChatbotGateService } from './chatbot-gate.service';
import { ChatbotSessionStore } from './chatbot-session.store';
import { ChatbotUsageService } from './chatbot-usage.service';

export class LinkPhoneDto {
  @IsString() phone!: string;
}

export class SwitchDto {
  @IsBoolean() enabled!: boolean;
}

export class AllowlistDto {
  /** Vacío = el bot atiende a todos. Con números = piloto. */
  @IsArray() @IsOptional() @IsString({ each: true }) phones?: string[];
}

export class BudgetDto {
  /** Tokens/día. 0 = sin tope. */
  @IsInt() @Min(0) dailyTokens!: number;
}

/**
 * Administración del agente de WhatsApp: estado y vinculación del número de cada
 * funcionario.
 *
 * La vinculación es lo que convierte a un número en "interno": sin ella, el
 * funcionario que escriba es tratado como abonado o como público. Por eso vive
 * detrás de `system.whatsapp` — vincular el número equivocado le entregaría a un
 * desconocido los permisos RBAC de ese empleado por WhatsApp.
 */
@Controller('admin/chatbot')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ChatbotController {
  constructor(
    private readonly chatbot: ChatbotService,
    private readonly links: ChatbotLinkService,
    private readonly gate: ChatbotGateService,
    private readonly store: ChatbotSessionStore,
    private readonly usage: ChatbotUsageService,
  ) {}

  /**
   * Estado del agente. Incluye el diagnóstico REAL contra Kapso y `operativo`, que
   * solo es true si además de encendido puede responder de verdad.
   */
  @Get('status')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  status() {
    return this.chatbot.status();
  }

  /**
   * Enciende o apaga el bot AL INSTANTE (surte efecto en ≤5s, sin reiniciar nada).
   * Es el botón de pánico: apagado, los mensajes entrantes se siguen registrando y los
   * atiende una persona, como antes de que el bot existiera.
   */
  @Put('switch')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  switch_(@Body() dto: SwitchDto, @CurrentUser() user: AuthUser) {
    return this.gate.setEnabled(dto.enabled, user?.email ?? user?.name);
  }

  /**
   * Lista blanca del piloto: si tiene números, el bot SOLO les responde a ellos.
   * Enviarla vacía lo abre a todos los abonados — hazlo a conciencia.
   */
  @Put('allowlist')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  allowlist(@Body() dto: AllowlistDto, @CurrentUser() user: AuthUser) {
    return this.gate.setAllowlist(dto.phones ?? [], user?.email ?? user?.name);
  }

  /**
   * Tope diario de tokens. 0 = sin tope. Al superarlo el bot deja de atender hasta el
   * día siguiente y el canal queda como apagado (lo atiende una persona).
   */
  @Put('budget')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  budget(@Body() dto: BudgetDto, @CurrentUser() user: AuthUser) {
    return this.usage.setBudget(dto.dailyTokens, user?.email ?? user?.name);
  }

  /**
   * Conversaciones que esperan a una persona (el cliente pidió hablar con alguien).
   * Es una cola de trabajo: la más vieja primero. Mientras estén aquí el bot NO
   * responde en ese chat.
   */
  @Get('handoffs')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  handoffs() {
    return this.store.listHandoffs();
  }

  /** Devuelve el bot a una conversación, una vez la persona la atendió. */
  @Delete('handoffs/:convKey')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  async releaseHandoff(@Param('convKey') convKey: string) {
    await this.store.clearHandoff(decodeURIComponent(convKey));
    return { ok: true };
  }

  /** Funcionarios con un número de WhatsApp vinculado. */
  @Get('vinculos')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  links_() {
    return this.links.list();
  }

  /** Vincula (o cambia) el WhatsApp de un usuario para que el agente lo trate como funcionario. */
  @Put('vinculos/:userId')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  link(@Param('userId') userId: string, @Body() dto: LinkPhoneDto) {
    return this.links.link(userId, dto.phone);
  }

  /** Desvincula el WhatsApp de un usuario (deja de ser interno para el agente). */
  @Delete('vinculos/:userId')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  unlink(@Param('userId') userId: string) {
    return this.links.unlink(userId);
  }
}
