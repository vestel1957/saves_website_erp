import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';
import { MailService } from './mail.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AreaGuard } from '../../auth/area.guard';
import { RequireArea } from '../../auth/require-area.decorator';

class UpdateEmailTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() bodyHtml?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class TestMailDto {
  @IsEmail() to!: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() message?: string;
}

/** Administración del correo saliente: estado SMTP, plantillas y prueba de envío. */
@Controller('admin/mail')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'sistemas', 'contabilidad')
export class MailController {
  constructor(private readonly mail: MailService) {}

  @Get('status')
  status() {
    return this.mail.status();
  }

  @Get('templates')
  templates() {
    return this.mail.listTemplates();
  }

  @Patch('templates/:id')
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateEmailTemplateDto) {
    return this.mail.updateTemplate(id, dto);
  }

  @Post('test')
  async test(@Body() dto: TestMailDto) {
    return this.mail.sendMail({
      to: dto.to,
      subject: dto.subject || 'Prueba de correo — Vestel',
      html: `<p>${dto.message || 'Este es un correo de prueba desde el sistema.'}</p>`,
    });
  }
}
