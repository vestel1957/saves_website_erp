import { Global, Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { SignatureController } from './signature.controller';
import { SignatureOtpService } from './signature-otp.service';
import { PasswordOtpService } from './password-otp.service';

/**
 * Firma con código de un solo uso (OTP).
 *
 * Exporta `SignatureOtpService` para que cualquier flujo que necesite una firma
 * real —hoy la aprobación de órdenes de compra; mañana los egresos de caja o la
 * salida de equipo entre sedes— pida y consuma el código sin reimplementar el
 * hash, los intentos ni el envío por WhatsApp.
 *
 * `@Global` y no un import más: los cambios de contraseña viven en `AuthModule`
 * (perfil y administración de usuarios) y éste importa `WhatsappModule`, que a su
 * vez importa `AuthModule` — importarlo allí cerraría el ciclo. Global rompe el
 * nudo sin `forwardRef` y sin partir los controladores de contraseña en un módulo
 * aparte solo para poder inyectar el OTP. No hay ciclo de PROVEEDORES: nada de lo
 * que hay aquí depende de `AuthService`.
 */
@Global()
@Module({
  imports: [WhatsappModule],
  controllers: [SignatureController],
  providers: [SignatureOtpService, PasswordOtpService],
  exports: [SignatureOtpService, PasswordOtpService],
})
export class SignatureModule {}
