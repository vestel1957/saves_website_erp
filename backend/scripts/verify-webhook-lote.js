/**
 * Verifica el parseo del webhook de WhatsApp — el punto donde el 2026-07-28 se
 * descubrió que TODOS los mensajes de clientes reales se estaban perdiendo.
 *
 * El webhook de Kapso tiene `buffer_enabled` (ventana de 5 s), así que los mensajes
 * no llegan sueltos sino agrupados en un sobre `{type, batch, data:[…], batch_info}`.
 * Ese sobre no se reconocía y se descartaba en silencio: cinco personas escribieron
 * pidiendo planes y nadie las atendió.
 *
 * No toca la BD, no llama a Kapso y no gasta LLM: alimenta el parser con los formatos
 * que Kapso puede mandar y comprueba qué mensajes salen por el evento entrante.
 *
 *   node backend/scripts/verify-webhook-lote.js
 */
const { WhatsappService } = require('../dist/src/common/whatsapp/whatsapp.service');
const { WHATSAPP_INBOUND_EVENT } = require('../dist/src/common/whatsapp/whatsapp.types');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  process.exitCode = 1;
};

/** Emisor de mentira: guarda lo que el servicio emite en vez de propagarlo. */
const recibidos = [];
const events = {
  emit: (name, payload) => {
    if (name === WHATSAPP_INBOUND_EVENT) recibidos.push(payload);
  },
};

const svc = new WhatsappService(events);

/** Mensaje de texto tal como lo entrega la Cloud API. */
const texto = (from, body, id) => ({ id, from, type: 'text', text: { body } });

const casos = [
  {
    titulo: 'LOTE de Kapso con dos mensajes (el formato que se estaba perdiendo)',
    payload: {
      type: 'whatsapp.message.received',
      batch: true,
      batch_info: { count: 2, window_seconds: 5 },
      data: [
        { message: texto('573197562434', 'Hola', 'wamid.A1'), conversation: { phone_number: '573197562434' } },
        { message: texto('573222270713', 'Estoy interesada en internet para el hogar', 'wamid.A2') },
      ],
    },
    espera: ['Hola', 'Estoy interesada en internet para el hogar'],
  },
  {
    titulo: 'LOTE cuyos elementos vienen envueltos en {event, data}',
    payload: {
      batch: true,
      batch_info: { count: 1 },
      data: [{ event: 'whatsapp.message.received', data: { message: texto('573132760810', '¿Cómo puedo pagar?', 'wamid.B1') } }],
    },
    espera: ['¿Cómo puedo pagar?'],
  },
  {
    titulo: 'mensaje suelto en formato Kapso (el que sí funcionaba)',
    payload: { message: texto('573233252764', 'Quiero conocer los planes', 'wamid.C1') },
    espera: ['Quiero conocer los planes'],
  },
  {
    titulo: 'reenvío en formato Meta (entry/changes)',
    payload: {
      entry: [{ changes: [{ value: { contacts: [{ wa_id: '573001112233' }], messages: [texto(null, 'Buenas', 'wamid.D1')] } }] }],
    },
    espera: ['Buenas'],
  },
  {
    titulo: 'foto: antes se ignoraba en silencio, ahora el bot se entera',
    payload: { message: { id: 'wamid.E1', from: '573001112233', type: 'image', image: { id: 'm1', caption: 'este es mi recibo' } } },
    espera: ['(el cliente envió una FOTO que no puedes ver. El pie del archivo dice: "este es mi recibo")'],
  },
  {
    titulo: 'eco de un mensaje saliente: NO debe re-entrar al bot',
    payload: { message: { id: 'wamid.F1', from: '573001112233', type: 'text', text: { body: 'respuesta del bot' }, kapso: { direction: 'outbound' } } },
    espera: [],
  },
  {
    titulo: 'evento de conversación creada: no es un mensaje, no emite nada',
    payload: { conversation: { id: 'c1', phone_number: '573001112233' }, phone_number_id: '1147160725154760' },
    espera: [],
  },
];

console.log('\n\x1b[1mVerificación del parser del webhook de WhatsApp\x1b[0m\n');

for (const c of casos) {
  recibidos.length = 0;
  svc.processWebhook(c.payload);
  const textos = recibidos.map((r) => r.text);
  const igual = textos.length === c.espera.length && textos.every((t, i) => t === c.espera[i]);
  igual
    ? ok(`${c.titulo} → ${textos.length} mensaje(s) al bot`)
    : bad(`${c.titulo}\n      esperaba: ${JSON.stringify(c.espera)}\n      obtuvo:   ${JSON.stringify(textos)}`);
}

// Un sobre que se referencia a sí mismo no debe colgar el proceso ni desbordar la pila.
recibidos.length = 0;
const ciclico = { batch: true, data: [] };
ciclico.data.push(ciclico);
try {
  svc.processWebhook(ciclico);
  ok('un lote recursivo se corta por profundidad en vez de desbordar la pila');
} catch (e) {
  bad(`el lote recursivo reventó: ${e.message}`);
}

console.log(
  process.exitCode ? '\n\x1b[31mHAY FALLOS.\x1b[0m\n' : '\n\x1b[32mTodo bien: los mensajes en lote llegan al bot.\x1b[0m\n',
);
