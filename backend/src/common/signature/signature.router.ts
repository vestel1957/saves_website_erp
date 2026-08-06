/**
 * Rutas de profile — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SignatureController, que ya no lleva decoradores.
 *
 * Endpoints: 6
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { validar } from '../../core/http/validar';
import { autenticar, usuarioDe } from '../../core/auth/instancias';
import { SignatureController } from './signature.controller';
import { signatureOtpService } from '../../core/contenedor';
import { SignatureOtpService } from './signature-otp.service';
import { SetSignaturePhoneDto, SignatureCodeDto } from './dto/signature.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const signature = new SignatureController(signatureOtpService);

export const signatureRouter = crearRouter();
signatureRouter.get(
  '/signature',
  autenticar,
  manejar((req) => signature.estado(usuarioDe(req))),
);

signatureRouter.get(
  '/signature/history',
  autenticar,
  manejar((req) => signature.historial(usuarioDe(req))),
);

signatureRouter.delete(
  '/signature/phone',
  autenticar,
  manejar((req) => signature.borrarPhone(usuarioDe(req))),
);

signatureRouter.put(
  '/signature/phone',
  autenticar,
  manejar((req) => signature.setPhone(usuarioDe(req), validar(SetSignaturePhoneDto, req.body))),
);

signatureRouter.post(
  '/signature/test',
  autenticar,
  manejar((req) => signature.probar(usuarioDe(req))),
);

signatureRouter.post(
  '/signature/verify',
  autenticar,
  manejar((req) => signature.verificar(usuarioDe(req), validar(SignatureCodeDto, req.body))),
);
