import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { ChatbotService } from './chatbot.service';
import { ChatbotLinkService } from './chatbot-link.service';

export class LinkPhoneDto {
  @IsString() phone!: string;
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
  ) {}

  /** Estado del agente: encendido, transporte y modelo. */
  @Get('status')
  @RequirePermissions(APP_PERMISSIONS.WHATSAPP_MANAGE)
  status() {
    return this.chatbot.status();
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
