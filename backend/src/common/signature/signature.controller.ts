import { Body, Controller, Delete, Get, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../../auth/current-user.decorator';
import { SignatureOtpService } from './signature-otp.service';
import { SetSignaturePhoneDto, SignatureCodeDto } from './dto/signature.dto';

/**
 * "Código de firma" de /perfil ▸ Seguridad: cada quien administra el suyo.
 *
 * Cuelga de `profile/…` aunque no viva en el AuthModule porque el módulo de firma
 * necesita WhatsApp y WhatsappModule ya importa AuthModule (meterlo allí cerraría
 * el ciclo). Para el frontend es una ruta más de su perfil, que es lo que importa.
 *
 * Sin guard de permisos, igual que el resto de `profile`: ninguna ruta recibe un
 * id de usuario, el sujeto es siempre `@CurrentUser()`. Nadie puede pedir ni
 * verificar el código de otro.
 */
@Controller('profile/signature')
@UseGuards(JwtAuthGuard)
export class SignatureController {
  constructor(private readonly firma: SignatureOtpService) {}

  @Get()
  estado(@CurrentUser() user: AuthUser) {
    return this.firma.estado(user.id);
  }

  @Get('history')
  historial(@CurrentUser() user: AuthUser) {
    return this.firma.historial(user.id);
  }

  @Put('phone')
  setPhone(@CurrentUser() user: AuthUser, @Body() dto: SetSignaturePhoneDto) {
    return this.firma.setTelefono(user.id, dto.phone);
  }

  @Delete('phone')
  borrarPhone(@CurrentUser() user: AuthUser) {
    return this.firma.borrarTelefono(user.id);
  }

  /** Manda un código de prueba: comprueba que el número recibe de verdad. */
  @Post('test')
  probar(@CurrentUser() user: AuthUser) {
    return this.firma.pedir({
      userId: user.id,
      purpose: 'profile.verify',
      detalle: 'la prueba de tu código de firma',
    });
  }

  /** Acierta el código de prueba ⇒ el número queda verificado. */
  @Post('verify')
  async verificar(@CurrentUser() user: AuthUser, @Body() dto: SignatureCodeDto) {
    await this.firma.firmar({ userId: user.id, purpose: 'profile.verify', code: dto.code });
    return this.firma.estado(user.id);
  }
}
