import { Logger } from '../../core/logger';
import { WhatsappService } from './whatsapp.service';
import { INTERNAL_ALERT_EVENT, type InternalAlert } from './whatsapp.types';

/**
 * Manda por WhatsApp los avisos dirigidos a funcionarios (los que nacen de
 * "Encargados por cargo").
 *
 * Existe como listener y no como llamada directa para cortar un ciclo de módulos:
 * quien decide a quién avisar es `ResponsibilitiesModule`, y la bandeja de WhatsApp
 * es uno de sus clientes. Con el evento, las flechas apuntan en un solo sentido.
 */
export class WhatsappInternalAlertListener {
  private readonly logger = new Logger('AvisoInternoWA');

  constructor(private readonly whatsapp: WhatsappService) {}

  async handle(alerta: InternalAlert): Promise<void> {
    const phones = [...new Set((alerta?.phones ?? []).map((p) => p.replace(/\D/g, '')).filter(Boolean))];
    if (!phones.length || !alerta?.text) return;

    // En serie, no en paralelo: son pocos números y Meta responde con rate-limit a
    // las ráfagas. Un aviso interno no tiene ninguna prisa por salir a la vez.
    for (const phone of phones) {
      // `reopenWithTemplate`: si el funcionario no le ha escrito al número del sistema
      // en 24 h —lo normal, no es un cliente— Meta prohíbe el texto libre y el aviso
      // moriría en un warning. La plantilla aprobada lo saca igual. Su cuerpo habla de
      // "tu servicio de internet" porque nació para clientes; suena raro para un
      // funcionario, pero un aviso raro que llega vale más que uno perfecto que no sale.
      const ok = await this.whatsapp.sendText(phone, alerta.text, { reopenWithTemplate: true });
      if (!ok) this.logger.warn(`El aviso interno no salió a ${phone}; queda en su campanita.`);
    }
  }
}
