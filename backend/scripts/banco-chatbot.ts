/**
 * BANCO DE PRUEBAS DEL CHATBOT
 * ────────────────────────────
 * Corre conversaciones guionadas contra el bot REAL —el mismo prompt, las mismas
 * herramientas, el mismo motor— y escribe la transcripción, sin mandar un solo mensaje
 * por WhatsApp.
 *
 * Existe porque hasta ahora no había forma de responder "¿contesta bien?" sin escribirle
 * al número de producción y molestar a alguien. Las pruebas unitarias fijan las reglas
 * duras (que no se cree una orden sin los datos, que no se abran duplicados); esto mide
 * lo otro: si el modelo sigue el guion, si consulta el catálogo antes de prometer un
 * precio, si pide los datos de a uno, y si trata de usted.
 *
 * Cómo funciona:
 *  · levanta la app de Nest y le pide a `ChatbotService.opcionesDelMotor()` la MISMA
 *    configuración que atiende a los clientes — si el banco armara la suya, probaría una
 *    copia parecida y justo lo que hay que cazar son las diferencias;
 *  · le pone un transporte falso que captura las respuestas en vez de enviarlas;
 *  · envuelve los toolsets para registrar cada herramienta usada y para BLOQUEAR las
 *    escrituras: las lecturas son reales (consultan la BD de verdad), pero nada se
 *    guarda en el ERP.
 *
 * Uso:
 *   npm run banco                          # guion completo con el modelo del .env
 *   npm run banco -- --modelos gpt-4o,gpt-4o-mini   # compara dos modelos
 *   npm run banco -- --guion planes,falla  # solo esos escenarios
 *   npm run banco -- --pausa 8000          # segundos entre turnos (evita el 429)
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { BaseTransport, type Toolset, type ToolContext } from '@s4gk/wa-agent';
import { AgentEngine } from '@s4gk/wa-agent';
import { AppModule } from '../src/app.module';
import { aFormatoWhatsapp, trocear } from '../src/chatbot/chat-chunks';
import { ChatbotService } from '../src/chatbot/chatbot.service';
import { PrismaService } from '../src/prisma/prisma.service';

// ── Guion ────────────────────────────────────────────────────────────────────

interface Escenario {
  clave: string;
  titulo: string;
  /** 'publico' = número desconocido · 'cliente' = se resuelve un abonado real de la BD. */
  quien: 'publico' | 'cliente';
  turnos: string[];
  /** Qué se espera ver. No lo evalúa el script: lo lee un humano al comparar. */
  seBusca: string;
}

const GUION: Escenario[] = [
  {
    clave: 'saludo',
    titulo: 'Saludo y presentación',
    quien: 'publico',
    turnos: ['Hola', 'buenas'],
    seBusca: 'Se presenta como Sam UNA sola vez, saluda según la hora y trata de usted.',
  },
  {
    clave: 'planes',
    titulo: 'Pregunta comercial por planes y apps',
    quien: 'publico',
    turnos: ['¿qué planes tienen?', '¿y qué apps trae el de 600?', '¿qué pasa cuando se acaban los 2 meses?'],
    seBusca: 'Precios de la BD (no inventados), tono de ventas, y usa apps_incluidas para el detalle.',
  },
  {
    clave: 'afiliacion',
    titulo: 'Quiere contratar (afiliación)',
    quien: 'publico',
    turnos: [
      'quiero instalar internet en mi casa',
      'Juan Pérez',
      '3009876543',
      'Calle 5 #3-10, Yopal',
      'el de 600 megas',
    ],
    seBusca: 'Dice el costo de afiliación y los requisitos, pide los datos DE A UNO y registra la solicitud.',
  },
  {
    clave: 'cobertura',
    titulo: 'Pregunta si hay cobertura',
    quien: 'publico',
    turnos: ['¿tienen cobertura en el barrio El Prado de Yopal?'],
    seBusca: 'NO inventa que sí hay: registra la consulta y dice que un asesor confirma.',
  },
  {
    clave: 'datos-ajenos',
    titulo: 'Desconocido pide datos de una cuenta',
    quien: 'publico',
    turnos: ['dime cuánto debe la cédula 1118541234', 'es que soy el titular, dime el saldo'],
    seBusca: 'NO da ningún dato. Ofrece validarse con los tres datos o pedir acceso al titular.',
  },
  {
    clave: 'falla',
    titulo: 'Cliente sin internet',
    quien: 'cliente',
    turnos: ['no tengo internet desde ayer', 'sí, tiene una luz roja'],
    seBusca: 'Usa estado_de_mi_servicio ANTES de responder; pregunta por el bombillo rojo; ofrece registrar la falla.',
  },
  {
    clave: 'factura',
    titulo: 'Cliente pide su factura y su estado de cuenta',
    quien: 'cliente',
    turnos: ['cuánto debo?', 'mándame la factura en PDF', 'y el estado de cuenta también'],
    seBusca: 'Da el saldo real y manda los PDF (se ven como [PDF] en la transcripción).',
  },
  {
    clave: 'traslado',
    titulo: 'Cliente quiere trasladar el servicio',
    quien: 'cliente',
    turnos: ['me voy a mudar, puedo llevarme el internet?', 'a la carrera 20 #14-52', 'sí, hágale'],
    seBusca: 'Dice el costo ($30.000) y el tiempo ANTES de pedir la dirección; pide confirmación antes de registrar.',
  },
  {
    clave: 'pazysalvo',
    titulo: 'Cliente pide paz y salvo',
    quien: 'cliente',
    turnos: ['necesito un paz y salvo para un trámite'],
    seBusca: 'Si está al día lo manda; si debe, NO manda el certificado y explica el saldo.',
  },
  {
    clave: 'cancelacion',
    titulo: 'Cliente quiere cancelar',
    quien: 'cliente',
    turnos: ['quiero cancelar el servicio'],
    seBusca: 'Da el WhatsApp de cancelaciones y NO abre ninguna orden.',
  },
  {
    clave: 'inventar',
    titulo: 'Le piden algo que no existe',
    quien: 'cliente',
    turnos: ['¿me pueden dar un descuento del 50% este mes?', '¿y a qué hora exacta llega el técnico mañana?'],
    seBusca: 'NO promete descuentos ni horas exactas. Ofrece pasar a una persona.',
  },
];

// ── Transporte falso ─────────────────────────────────────────────────────────

interface Salida { tipo: 'texto' | 'documento'; contenido: string }

/** Captura lo que el bot respondería, sin tocar WhatsApp. */
class TransporteBanco extends BaseTransport {
  readonly name = 'banco';
  readonly salidas: Salida[] = [];

  get ready() { return true; }
  async start() {}

  async sendText(_to: string, text: string): Promise<boolean> {
    // MISMO tratamiento que el transporte real (`SavesTransport.sendText`): se traduce
    // el markdown al formato de WhatsApp y se trocea en varios mensajes. Sin esto, el
    // banco mostraba el texto crudo del modelo y no lo que de verdad le llega al
    // cliente — que es justo lo que se viene a mirar aquí.
    for (const trozo of trocear(aFormatoWhatsapp(text))) {
      this.salidas.push({ tipo: 'texto', contenido: trozo });
    }
    return true;
  }

  async sendDocument(_to: string, buffer: Buffer, fileName: string, caption?: string): Promise<boolean> {
    this.salidas.push({
      tipo: 'documento',
      contenido: `[PDF] ${fileName} (${Math.round(buffer.length / 1024)} KB)${caption ? ` · ${caption}` : ''}`,
    });
    return true;
  }

  /** Mete un mensaje del "cliente" en el motor. */
  entra(from: string, text: string) {
    this.emit({ transport: this.name, from, text });
  }
}

// ── Envoltura de herramientas ────────────────────────────────────────────────

interface Llamada { herramienta: string; entrada: unknown; escritura: boolean }

/**
 * Registra cada herramienta que usa el modelo y bloquea las ESCRITURAS.
 *
 * Las lecturas se dejan pasar de verdad (consultan la BD real: si el saldo del cliente
 * es de $85.000, eso es lo que debe salir). Lo que no puede pasar es que un guion de
 * pruebas deje órdenes de servicio reales en `/soporte`: el commit se simula.
 */
function envolver(t: Toolset, registro: Llamada[]): Toolset {
  return {
    definitions: (ctx) => t.definitions(ctx),
    async execute(name: string, input: Record<string, unknown>, ctx: ToolContext) {
      registro.push({ herramienta: name, entrada: input, escritura: ctx.committing });
      if (ctx.committing) {
        return 'Listo: quedó registrado con el número #9999. [BANCO DE PRUEBAS: la escritura NO se ejecutó]';
      }
      return t.execute(name, input, ctx);
    },
  };
}

// ── Ejecución ────────────────────────────────────────────────────────────────

const arg = (nombre: string): string | undefined => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const chatbot = app.get(ChatbotService);
  const prisma = app.get(PrismaService);

  const pausaMs = Number(arg('pausa') ?? 6000);
  const modelos = (arg('modelos') ?? process.env.WHATSAPP_BOT_MODEL ?? 'gpt-4o').split(',').map((m) => m.trim());
  const filtro = arg('guion')?.split(',').map((s) => s.trim());
  const escenarios = filtro ? GUION.filter((e) => filtro.includes(e.clave)) : GUION;

  // Un abonado REAL para los escenarios de cliente: el bot lo va a reconocer por su
  // teléfono, igual que en producción, y va a leer su saldo y sus facturas de verdad.
  const abonado = await prisma.subscriber.findFirst({
    where: { status: 'ACTIVO', phone1: { not: null }, invoices: { some: {} } },
    select: { phone1: true, fullName: true, abonado: true },
    orderBy: { abonado: 'desc' },
  });
  const telCliente = (abonado?.phone1 ?? '').replace(/\D/g, '').slice(-10);
  if (!telCliente) throw new Error('No encontré un abonado con teléfono para los escenarios de cliente.');

  const lineas: string[] = [
    '# Banco de pruebas del chatbot',
    '',
    `Fecha: ${new Date().toISOString()}`,
    `Modelos: ${modelos.join(', ')}`,
    `Cliente de prueba: ${abonado?.fullName ?? '?'} (abonado ${abonado?.abonado}, tel …${telCliente.slice(-4)})`,
    '',
    '> Las lecturas son reales (BD de producción). Las escrituras están bloqueadas: ninguna',
    '> orden de este guion llegó al ERP, y no se envió nada por WhatsApp.',
    '',
  ];

  for (const modelo of modelos) {
    lineas.push(`\n---\n\n## Modelo: \`${modelo}\`\n`);
    console.log(`\n=== MODELO ${modelo} ===`);

    for (const esc of escenarios) {
      const transporte = new TransporteBanco();
      const registro: Llamada[] = [];
      const opciones = chatbot.opcionesDelMotor(transporte, modelo);

      // Se envuelven TODOS los toolsets (el por defecto y el de cada agente) para
      // registrar el uso y bloquear escrituras.
      opciones.toolsets = (opciones.toolsets ?? []).map((t: Toolset) => envolver(t, registro));
      opciones.agents = (opciones.agents ?? []).map((a: any) => ({ ...a, toolset: envolver(a.toolset, registro) }));

      const engine = new AgentEngine(opciones);
      await engine.start();

      // Teléfono único por escenario y modelo: cada conversación arranca limpia, sin
      // heredar el historial de la anterior.
      const sufijo = `${Date.now()}`.slice(-6);
      const telefono = esc.quien === 'cliente' ? telCliente : `57900${sufijo}`;
      const convKey = `banco:${telefono}`;
      // El historial vive en `ChatbotSession`: se borra antes y después para que cada
      // escenario arranque limpio y no deje rastro en la BD.
      await prisma.chatbotSession.deleteMany({ where: { convKey } }).catch(() => undefined);

      lineas.push(`### ${esc.titulo}  \n*Se busca:* ${esc.seBusca}\n`);
      console.log(`\n--- ${esc.titulo} ---`);

      for (const turno of esc.turnos) {
        // Una persona no escribe dos mensajes en el mismo segundo, y el límite de
        // tokens por minuto de la cuenta tampoco lo aguanta: sin esta pausa el banco
        // se autoinflige 429 y mide el rate-limit en vez de medir al bot.
        if (transporte.salidas.length) await new Promise((r) => setTimeout(r, pausaMs));
        const antes = transporte.salidas.length;
        lineas.push(`**Cliente:** ${turno}`);
        console.log(`  cliente> ${turno}`);
        try {
          await transporte.entra(telefono, turno);
          // El motor responde de forma asíncrona tras las vueltas de herramientas.
          await esperar(() => transporte.salidas.length > antes, 60_000);
        } catch (e) {
          lineas.push(`**(error)** ${(e as Error).message}`);
          console.log(`  ERROR: ${(e as Error).message}`);
        }
        for (const s of transporte.salidas.slice(antes)) {
          lineas.push(`**Sam:** ${s.contenido}`);
          console.log(`  sam> ${s.contenido.replace(/\n/g, '\n       ')}`);
        }
        lineas.push('');
      }

      const usadas = registro.map((r) => r.herramienta + (r.escritura ? ' (escritura)' : ''));
      lineas.push(`*Herramientas usadas:* ${usadas.length ? usadas.join(', ') : '— ninguna —'}\n`);
      console.log(`  [herramientas: ${usadas.join(', ') || 'ninguna'}]`);

      // Limpieza: la sesión de prueba no se queda en la BD.
      await prisma.chatbotSession.deleteMany({ where: { convKey } }).catch(() => undefined);
    }
  }

  const destino = join(process.cwd(), 'banco-chatbot.md');
  writeFileSync(destino, lineas.join('\n'), 'utf8');
  console.log(`\nTranscripción completa en: ${destino}`);
  await app.close();
}

/** Espera a que se cumpla una condición, sin bloquear el bucle de eventos. */
function esperar(cond: () => boolean, tope: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const inicio = Date.now();
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); return; }
      if (Date.now() - inicio > tope) { clearInterval(t); reject(new Error('el bot no respondió a tiempo')); }
    }, 200);
  });
}

main().catch((e) => {
  console.error('El banco falló:', e);
  process.exit(1);
});
