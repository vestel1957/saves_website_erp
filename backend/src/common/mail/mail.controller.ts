import { IsBoolean, IsEmail, IsOptional, IsString } from 'class-validator';
import { MailService } from './mail.service';

export class UpdateEmailTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() bodyHtml?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class TestMailDto {
  @IsEmail() to!: string;
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() message?: string;
}

/** Administración del correo saliente: estado SMTP, plantillas y prueba de envío. */
export class MailController {
  constructor(private readonly mail: MailService) {}

  status() {
    return this.mail.status();
  }

  templates() {
    return this.mail.listTemplates();
  }

  updateTemplate(id: string, dto: UpdateEmailTemplateDto) {
    return this.mail.updateTemplate(id, dto);
  }

  async test(dto: TestMailDto) {
    return this.mail.sendMail({
      to: dto.to,
      subject: dto.subject || 'Prueba de correo — Vestel',
      html: `<p>${dto.message || 'Este es un correo de prueba desde el sistema.'}</p>`,
    });
  }
}
