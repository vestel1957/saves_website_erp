# Manual de Sistemas

Este manual está dirigido al rol de **Sistemas (Configuración)** de SAVES, el software de gestión del proveedor de internet Vestel. Desde este rol se define cómo está montada la empresa (datos, sedes, cajas), qué planes de internet y televisión se venden, cómo el sistema se comunica con los clientes por WhatsApp y qué tareas ejecuta el sistema de forma automática. No necesitas conocimientos técnicos avanzados: cada pantalla se explica paso a paso.

> **Cómo funciona la pantalla en general.** El menú de la izquierda solo muestra las opciones para las que tienes permiso; si no ves una opción, es porque tu usuario no la tiene habilitada. Al guardar cualquier cambio aparece un aviso: verde cuando salió bien y rojo cuando hubo un error. Las listas largas casi siempre traen un buscador para filtrar rápido.

# Configuración

## Empresa

**Dónde:** menú Configuración (opción principal, ruta `/configuracion`).

**Para qué sirve.** Guarda los datos básicos de Vestel (nombre, NIT, dirección, contacto) y te deja consultar las sedes y las cajas de la empresa. Es la información que el sistema usa como referencia en facturas y reportes.

**Qué vas a ver.** En la parte de arriba hay tres pestañas. Cada una muestra una cosa distinta:

| Pestaña | Qué muestra |
| --- | --- |
| Empresa | Formulario con los datos de la empresa (editable). |
| Sedes | Lista de sedes con su dirección y cuántos abonados tiene cada una. |
| Cajas | Lista de cuentas de caja (titular, número de cuenta, sede y saldo). Solo consulta. |

**Paso a paso (editar los datos de la empresa):**

1. Entra a Configuración y quédate en la pestaña **Empresa**.
2. Completa o corrige los campos: Nombre, NIT / Tax ID (el número de identificación tributaria de la empresa), Dirección, Ciudad, Departamento / Región, Teléfono y Correo.
3. Presiona **Guardar**. Espera el aviso verde "Empresa actualizada".

**Paso a paso (editar una sede):**

1. Ve a la pestaña **Sedes**.
2. Ubica la sede en la lista y presiona **Editar** a la derecha.
3. Cambia el Nombre, el Resumen o la Dirección y presiona **Guardar**.

> La pestaña **Cajas** es solo de consulta: te sirve para revisar saldos, pero no se edita desde aquí.

## Planes de servicio

**Dónde:** menú Configuración > Planes (`/configuracion/planes`).

**Para qué sirve.** Es el catálogo de planes que Vestel vende (internet, televisión, etc.). Este catálogo define el precio de la mensualidad que se le cobra al cliente y el "perfil" que se le envía al router para darle la velocidad contratada. Si un plan está mal aquí, se factura mal.

**Qué vas a ver.** Una lista de planes. Cada uno muestra su nombre, el tipo de servicio, el perfil del router, el IVA, la velocidad, cuántos abonados lo tienen y el precio mensual. Los tipos de servicio disponibles son:

| Tipo | Significado |
| --- | --- |
| Internet | Plan de acceso a internet. |
| Televisión | Plan de TV. |
| Puntos TV | Puntos adicionales de televisión. |
| Streaming | Servicio de streaming. |

**Paso a paso (crear un plan):**

1. Presiona **Nuevo plan** (arriba a la derecha).
2. Escribe el **Nombre** (ejemplo: "300 Megas ST").
3. Elige el **Tipo de servicio**.
4. Escribe el **Precio mensual (COP)**: es el valor base, sin IVA.
5. Indica el **IVA (%)**. Como guía: Internet normalmente va en 0 y Televisión en 19.
6. En **Perfil PPP (router)** escribe el nombre del perfil que el router usa para dar la velocidad (ejemplo: "300M"). El "PPP" es la forma en que el router identifica la conexión del cliente. Si lo dejas vacío, el sistema no le empuja ningún perfil al router.
7. En **Velocidad (Mbps)** escribe la velocidad. Este dato es solo informativo.
8. Deja marcado **Activo** para que el plan se pueda asignar a clientes.
9. Presiona **Guardar**.

**Paso a paso (editar o eliminar):**

1. En la tarjeta del plan, usa el ícono de lápiz para **editar** o el de basura para **eliminar**.
2. Al eliminar, el sistema pide confirmación. Si el plan está en uso por algún abonado, no se borra: se **desactiva** (queda como "Inactivo") para no dañar la facturación de quienes ya lo tienen.

> Cambiar el precio o el perfil de un plan afecta a todos los abonados que lo tienen. Revisa dos veces antes de guardar.

## Categorías de transacción

**Dónde:** menú Configuración > Categorías (`/configuracion/categorias`).

**Para qué sirve.** Son etiquetas para clasificar los ingresos y egresos de tesorería (por ejemplo "Servicios públicos", "Arriendo", "Nómina"). Ayudan a que los movimientos de caja queden ordenados y sean fáciles de reportar.

**Qué vas a ver.** Una lista de categorías. Cada una muestra su nombre y cuántos movimientos la usan (etiqueta "X mov.").

**Paso a paso (crear una categoría):**

1. Presiona **Nueva categoría**.
2. Escribe el **Nombre** (mínimo 2 caracteres).
3. Presiona **Guardar** (o la tecla Enter).

**Paso a paso (editar o eliminar):**

1. Usa el ícono de lápiz para renombrar. Si la categoría ya tiene movimientos, al renombrarla se actualizan automáticamente todas esas transacciones.
2. Usa el ícono de basura para eliminar. Solo se pueden eliminar categorías que **no** estén en uso; si tiene movimientos, el botón de basura aparece deshabilitado.

## Usuarios y roles

**Dónde:** menú Configuración > Usuarios y roles (`/configuracion/usuarios`).

**Para qué sirve.** Aquí se crean los usuarios que entran al sistema, se les asignan roles (paquetes de permisos) y se define a qué pantallas puede entrar cada persona. Es una pantalla sensible: solo la ve quien tiene el permiso de administrar usuarios.

**Qué vas a ver.**

- Tres tarjetas de resumen: total de usuarios, usuarios activos y cantidad de roles definidos.
- La lista de **Usuarios** (con buscador por nombre o correo), cada uno con sus roles y su estado (Activo / Inactivo).
- La sección **Roles y permisos**, agrupada por área, donde cada rol muestra qué permisos concede.

**Paso a paso (crear un usuario):**

1. Presiona **Nuevo usuario**.
2. Escribe el nombre completo, el correo y una contraseña temporal (mínimo 8 caracteres).
3. Marca los roles que le corresponden. Al asignar un rol, el usuario hereda automáticamente los permisos de ese rol.
4. Presiona **Crear usuario**.

**Paso a paso (otras acciones sobre un usuario):**

1. Botón **Editar**: cambia nombre/correo y permite restablecer la contraseña.
2. Botón **Roles**: ajusta los roles base y, si hace falta, marca o desmarca pantallas puntuales como excepción para esa persona.
3. Botón **Desactivar / Activar**: un usuario desactivado no puede iniciar sesión. No puedes desactivar tu propia cuenta.

> Esta pantalla también incluye el constructor de roles (crear, clonar y editar roles). El detalle completo de roles y permisos se explica en el **Manual del Superadministrador**, porque varias de esas acciones solo las hace el superusuario.

## REST API

**Dónde:** menú Configuración > REST API (`/configuracion/api`).

**Para qué sirve.** Una **API** es la puerta por la que otro programa (por ejemplo un portal de pagos o una página web) se conecta a SAVES para leer información, sin necesidad de una persona escribiendo. Para que ese otro programa entre, necesita una **llave** (una clave secreta). En esta pantalla creas y administras esas llaves. Solo Sistemas puede hacerlo.

**Qué vas a ver.**

- Un formulario **Nueva clave**.
- La lista de claves existentes, con su nombre, permisos, uso (cuántas veces se ha usado y desde qué IP), y estado (Activa, Inactiva o Revocada).
- Una sección **Cómo se usa** con la dirección técnica de conexión y ejemplos, para entregársela a quien va a integrar el sistema.

**Paso a paso (crear una clave):**

1. En **Nombre del tercero / integración** escribe para quién es (ejemplo: "Portal de pagos").
2. En **Límite por hora** define cuántas consultas puede hacer esa clave en una hora (0 = sin límite). Esto evita que un sistema mal configurado sature al servidor.
3. En **IPs permitidas** puedes escribir las direcciones desde donde se aceptan las consultas, separadas por coma. Si lo dejas vacío, se acepta desde cualquier lado. (Una IP es la dirección de un computador o servidor en internet.)
4. En **Permisos (scopes)** marca a qué puede acceder la clave (por ejemplo, leer clientes o leer facturas). Elige lo mínimo necesario.
5. Presiona **Crear clave**.
6. El sistema muestra la clave **una sola vez**. Cópiala con el botón **Copiar** y guárdala en un lugar seguro.

**Paso a paso (administrar una clave):**

1. **Desactivar / Activar**: apaga o enciende temporalmente la clave.
2. **Revocar**: la anula de forma permanente. Úsalo si la clave se filtró o ya no se necesita.

> Por seguridad, la clave completa se muestra solo en el momento de crearla. Si la pierdes, no se puede recuperar: hay que revocarla y crear una nueva.

## Cron job / Automatizaciones

**Dónde:** menú Configuración > Automatizaciones (`/configuracion/automatizaciones`).

**Para qué sirve.** Un **cron job** (o "tarea programada") es una tarea que el sistema ejecuta solo, a una hora fija, sin que nadie la dispare. Aquí se controlan las automatizaciones de facturación y cartera: puedes ver si están activas, cuándo corrieron por última vez y dispararlas manualmente si hace falta.

**Qué vas a ver.**

- Un aviso arriba que indica si las tareas programadas están **activas** (corren solas en su horario) o **en pausa**. Aun en pausa, el disparo manual siempre funciona.
- Tres tarjetas, una por tarea:

| Tarea | Qué hace |
| --- | --- |
| Facturación recurrente | Genera las facturas del mes a los abonados. |
| Paso a cartera | Mueve a "cartera" a los clientes que quedaron debiendo. |
| Tasa de cambio | Actualiza la tasa de cambio (sin acción manual: la operación es en pesos colombianos). |

- Un **Historial de corridas** con la fecha, si fue Manual o Programada, el resultado (OK / Error) y el detalle.

**Paso a paso (ejecutar una tarea manualmente):**

1. Ubica la tarjeta de la tarea.
2. En **Facturación recurrente** presiona **Generar ahora**; al terminar verás cuántas facturas se generaron y cuántas se omitieron.
3. En **Paso a cartera** presiona **Ejecutar ahora**; al terminar verás cuántos clientes se movieron a cartera.
4. Revisa el resultado en el aviso y en el historial.

> "Generar ahora" crea facturas reales. Úsalo con cuidado y solo cuando estés seguro; normalmente estas tareas corren solas en su horario.

## Bitácora / auditoría

**Dónde:** menú Configuración > Bitácora / Auditoría (`/configuracion/actividad`).

**Para qué sirve.** Es el registro de **quién hizo qué** en el sistema. Cada vez que alguien crea, modifica o borra algo, queda una huella. Sirve para investigar errores o revisar responsabilidades. Es solo de consulta: no se puede editar ni borrar.

**Qué vas a ver.** Una tabla con: fecha y hora, usuario, la acción realizada, el módulo afectado y la dirección IP desde donde se hizo. Arriba hay filtros.

**Paso a paso (buscar en la bitácora):**

1. Usa **Buscar acción** para filtrar por texto de la acción.
2. Usa **Módulo** para acotar a un área (por ejemplo, "subscribers" o "treasury").
3. Usa **Desde** y **Hasta** para limitar el rango de fechas.
4. Si hay muchos resultados, navega con la paginación al pie de la tabla.

## Importar / Exportar

**Dónde:** menú Configuración > Importar / Exportar (`/configuracion/datos`).

**Para qué sirve.** Permite **descargar** datos del sistema a Excel y **cargar** información en masa desde Excel, sin ingresarla una por una. Un archivo Excel (extensión .xlsx) es una hoja de cálculo; CSV es un formato de texto parecido, también de tabla.

**Qué vas a ver.**

- Una sección **Exportar a Excel** con botones para descargar: Clientes, Equipos, Materiales y Facturas.
- Una sección **Importar equipos desde Excel** para cargar equipos en masa.

**Paso a paso (exportar):**

1. En **Exportar a Excel**, presiona el botón del dato que quieres (por ejemplo, Clientes).
2. Espera a que se genere y se descargue el archivo .xlsx.

**Paso a paso (importar equipos):**

1. Prepara un Excel con las columnas: Código, MAC, Serial, Marca, Estado.
2. Presiona el selector de archivo y elige tu .xlsx.
3. Presiona **Validar (vista previa)**. El sistema revisa el archivo y muestra cuántas filas son válidas y cuántas tienen error, sin guardar nada todavía.
4. Revisa la vista previa y los errores señalados (indican la fila y el motivo).
5. Si todo está bien, presiona **Confirmar X equipos** para cargarlos de verdad.

> Siempre valida primero. La vista previa no guarda nada; solo la confirmación crea los registros. Así evitas cargar datos con errores.

## Documentos

**Dónde:** menú PERSONAS / PROYECTOS > Documentos (`/documentos`).

**Para qué sirve.** Es la biblioteca de documentos de Vestel: un lugar para subir y guardar archivos (contratos, formatos, manuales) organizados por carpetas.

**Qué vas a ver.** Un formulario para subir un archivo, las carpetas existentes con su conteo, y una tabla con los documentos (título, archivo, carpeta, fecha) y un botón para descargar cada uno.

**Paso a paso (subir un documento):**

1. (Opcional) Escribe un **Título** para el documento.
2. Presiona el selector de archivo y elige el archivo desde tu computador.
3. Presiona **Subir documento**. Espera el aviso verde.

**Paso a paso (descargar):**

1. En la tabla, presiona **Descargar** en la fila del documento.

> Algunos documentos antiguos (migrados) solo conservan la información de referencia y no tienen archivo para descargar; en esos casos aparecen marcados como "solo metadata".

# WhatsApp

## Inbox

**Dónde:** menú Configuración > Mensajería (`/configuracion/mensajes`).

**Para qué sirve.** Es la bitácora de los mensajes y campañas que el sistema ha registrado. Sirve para consultar qué se ha enviado y el contenido de esos mensajes.

**Qué vas a ver.** Un buscador y una lista de mensajes. Cada uno muestra la campaña a la que pertenece (si aplica), la fecha y hora, y el texto del mensaje.

**Paso a paso:**

1. Usa el buscador para filtrar por nombre de campaña o por contenido del mensaje.
2. Navega con la paginación al pie si hay muchos registros.

> Esta pantalla es de consulta. Para conversar en tiempo real con un cliente o ver los mensajes entrantes y salientes de WhatsApp, usa la pantalla **Configurar API** (sección "Conversaciones recientes").

## Agente (bot)

**Dónde:** menú Configuración > Agente de WhatsApp (`/configuracion/chatbot`).

**Para qué sirve.** El **agente** o **bot** es un asistente automático que responde por WhatsApp a los clientes sin que intervenga una persona. Aquí lo enciendes o apagas, decides a quién responde durante una prueba, controlas cuánto puede gastar y atiendes los casos que pidieron hablar con un humano. Solo lo ve quien administra WhatsApp.

**Qué vas a ver.** La pantalla está dividida en secciones:

| Sección | Para qué |
| --- | --- |
| Estado | Dice si el bot está atendiendo y enumera las condiciones que deben cumplirse (interruptor encendido, motor listo, WhatsApp puede enviar, dentro del tope). |
| Lista blanca (piloto) | Números a los que responde el bot mientras haces pruebas. |
| Consumo del modelo | Cuántos "tokens" ha gastado hoy y el tope diario. |
| Esperando a una persona | Chats que pidieron hablar con un humano. |

> Un **token** es la unidad con la que se mide el consumo del asistente de inteligencia artificial. A más conversación, más tokens se gastan.

**Paso a paso (encender o apagar el bot):**

1. En la sección **Estado**, presiona **Encender el bot** o **Apagar el bot**.
2. Revisa la lista de condiciones (marcadas con ✓ o ✗). Si "WhatsApp puede enviar" está en ✗, el bot leería los mensajes pero sus respuestas no saldrían: hay que arreglar la conexión de WhatsApp antes.

> Con el bot apagado, los mensajes de los clientes se siguen registrando y los atiende una persona, igual que antes de que el bot existiera.

**Paso a paso (piloto con lista blanca):**

1. En **Lista blanca (piloto)**, escribe los teléfonos separados por coma.
2. Presiona **Guardar lista**. Con números en la lista, el bot **solo** responde a esos números.
3. Si dejas la lista **vacía**, el bot responde a **cualquiera** que escriba (son miles de abonados). Vacíala solo cuando el piloto te dé confianza.

**Paso a paso (tope de consumo):**

1. En **Consumo del modelo**, escribe el **Tope diario (tokens)** (0 = sin tope).
2. Presiona **Guardar tope**. Al superar el tope, el bot deja de atender hasta el día siguiente. Es un freno de emergencia contra gastos inesperados.

**Paso a paso (conversaciones escaladas):**

1. En **Esperando a una persona** verás los clientes que pidieron hablar con alguien; en esos chats el bot ya no responde.
2. Atiende al cliente desde el Inbox.
3. Cuando termines, presiona **Devolver al bot** para que el asistente vuelva a atender ese chat.

## Plantillas

**Dónde:** menú Configuración > WhatsApp > Plantillas (`/configuracion/whatsapp/plantillas`).

**Para qué sirve.** Una **plantilla** es un mensaje prediseñado y aprobado por Meta (la empresa dueña de WhatsApp) que se puede enviar a los clientes. Para poder hacer envíos masivos, primero deben existir plantillas aquí. En esta pantalla se registran esas plantillas y se define qué datos van en cada hueco variable.

**Qué vas a ver.** Una tabla con las plantillas: nombre, idioma, categoría, número de variables y estado (Activa / Inactiva).

**Paso a paso (crear una plantilla):**

1. Presiona **Nueva plantilla**.
2. En **Nombre exacto (Meta)** escribe el nombre tal como fue aprobado en Meta (ejemplo: "factura_disponible"). Debe coincidir exactamente.
3. Elige el **Idioma** (Español, Español (Colombia) o Inglés) y la **Categoría** (UTILITY para avisos de servicio, MARKETING para promociones, AUTHENTICATION para códigos).
4. (Opcional) Escribe un **Encabezado**.
5. En **Cuerpo** escribe el texto. Usa `{{1}}`, `{{2}}`, etc., donde quieras que se inserte un dato del cliente. Ejemplo: "Hola {{1}}, tu factura por {{2}} ya está disponible."
6. Presiona **Añadir variable** por cada hueco. Para cada variable, ponle una etiqueta y elige de dónde sale el dato:

| Origen | Qué inserta |
| --- | --- |
| Nombre del cliente | El nombre completo. |
| Primer nombre | Solo el primer nombre. |
| N.º de abonado | El número de abonado. |
| Teléfono | El teléfono del cliente. |
| Deuda pendiente | El valor que debe. |
| Valor fijo | Un texto fijo que tú escribes. |

7. Deja marcada **Activa** para poder usarla en campañas.
8. Presiona **Crear plantilla**.

> El nombre de la plantilla debe existir y estar aprobado en Meta; si no coincide, el envío fallará. Esta pantalla registra la referencia y el mapeo de variables, pero la aprobación se hace del lado de Meta.

## Envío masivo

**Dónde:** menú Configuración > WhatsApp > Envío masivo (`/configuracion/whatsapp/masivo`).

**Para qué sirve.** Enviar una plantilla de WhatsApp a un grupo de clientes de una sola vez (una "campaña"), y luego ver el reporte de cuántos mensajes se entregaron, se leyeron o fallaron.

**Qué vas a ver.**

- Un formulario **Nueva campaña**.
- Una tabla **Campañas** con el histórico: nombre, plantilla, total, enviados, entregados, leídos, fallidos, estado y fecha, con un botón **Ver** para el reporte detallado.

**Paso a paso (lanzar una campaña):**

1. En **Nombre de la campaña** escribe un nombre (ejemplo: "Factura julio").
2. En **Plantilla** elige una de las plantillas activas.
3. En **Clientes con estado** elige a quién enviar según su estado: Activo, Cortado, Cartera, Suspendido o Retirado.
4. (Opcional) En **Filtro** escribe un nombre, cédula o teléfono para acotar aún más.
5. Presiona **Lanzar campaña**. Se enviará solo a los clientes que cumplan el filtro y que tengan un teléfono válido. Verás cuántos destinatarios recibieron el envío.

**Paso a paso (ver el reporte y reintentar):**

1. En la tabla **Campañas**, presiona **Ver**.
2. Revisa los totales por estado (Total, Enviados, Entregados, Leídos, Fallidos) y el detalle por cliente.
3. Si hubo fallidos, presiona **Reintentar fallidos** para volver a encolar solo esos envíos.

> Si aún no hay plantillas, la pantalla te pedirá crear una primero. Sin plantilla no se puede lanzar una campaña.

## Configurar API

**Dónde:** menú Configuración > WhatsApp (`/configuracion/whatsapp`).

**Para qué sirve.** Conectar y verificar la cuenta de WhatsApp de Vestel. Vestel usa un proveedor llamado **Kapso**, que se apoya en la Cloud API oficial de Meta (la vía autorizada para enviar WhatsApp desde un sistema, sin QR ni riesgo de bloqueo). Aquí ves si el canal está conectado, envías un mensaje de prueba y revisas las conversaciones. Solo lo ven los administradores.

**Qué vas a ver.**

- Una etiqueta que dice "Kapso: conectado" o "Kapso: sin configurar".
- Una tarjeta con el **estado del canal**. Si falta configuración, lista qué credenciales hacen falta en el servidor.
- Una tarjeta para **enviar un mensaje de prueba**.
- Una sección **Conversaciones recientes** con los mensajes enviados y recibidos.

**Paso a paso (enviar una prueba):**

1. Asegúrate de que la etiqueta diga "Kapso: conectado".
2. En **Número destino** escribe el número en formato internacional sin el signo +, por ejemplo `573001112233`.
3. Escribe el **Mensaje** o deja el de ejemplo.
4. Presiona **Enviar prueba** y revisa el aviso de resultado.

> Las credenciales de Kapso (las claves de conexión) se configuran en el servidor, no desde esta pantalla. Si el canal aparece "sin configurar", la pantalla te muestra exactamente qué falta (marcado con ✓ o ✗) para que se lo pidas a quien administra el servidor. Los mensajes entrantes aparecen en "Conversaciones recientes" cuando Kapso los reenvía al sistema.

## Promociones

**Dónde:** menú Configuración > Promociones (`/configuracion/promociones`).

**Para qué sirve.** Crear campañas de descuento **dirigidas a clientes**: cada promoción define a qué clientes alcanza (su *público*) y solo aparece en las facturas de esos clientes, donde se aplica como nota crédito mientras esté vigente. Así nadie puede descontarle a un cliente que no correspondía. Solo el superusuario administra esta pantalla.

**Qué vas a ver.**

- Dos pestañas arriba: **Promociones** y **Bitácora del público**.
- En Promociones: tres indicadores (Vigentes, Programadas, Aplicaciones), un buscador con filtros (Todas / Vigentes / Programadas) y las promociones en tarjetas. Cada tarjeta muestra un bloque **Aplica a** con el público de esa promoción.
- En Bitácora del público: el registro de qué destinatario entró o salió del público de cada promoción, quién lo hizo y cuándo. Es la traza que responde "¿por qué a este cliente se le descontó?".

**Paso a paso (crear una promoción):**

1. Presiona **Nueva promoción**.
2. Escribe el **Nombre de la campaña** (ejemplo: "10% Cortados").
3. Elige el **Tipo de descuento** y escribe el valor:

| Tipo de descuento | Qué hace |
| --- | --- |
| % Descuento (después de imp.) | Un porcentaje aplicado sobre el total con impuestos. |
| Monto fijo (después de imp.) | Un valor fijo en pesos, sobre el total con impuestos. |
| % Descuento (antes de imp.) | Un porcentaje aplicado antes de los impuestos. |
| Monto fijo (antes de imp.) | Un valor fijo en pesos, antes de impuestos. |

4. Para porcentaje, escribe un número entre 1 y 100. Para monto fijo, un valor mayor a $0.
5. (Opcional) Escribe una **Descripción**.
6. Define **Inicia** y **Finaliza** (la fecha final no puede ser anterior a la inicial).
7. Deja marcada **Activa**.
8. En **¿A qué clientes aplica?** define el público:
   - **Todos los clientes:** sin excepciones (ignora los demás criterios).
   - **Estado del cliente:** por ejemplo Activo, o Cartera.
   - **Clientes puntuales:** busca y agrega uno por uno los clientes que quieras.
   - **Plan contratado:** todos los que tengan ese plan.
   - **Sede** y **Barrio:** todos los de esa sede o ese barrio.
9. Mira el contador **Clientes alcanzados**: te dice, antes de guardar, a cuántos clientes reales llega la promoción (con "Ver ejemplos" puedes revisar algunos nombres). Si dice 0, la promoción no aparecerá en ninguna factura.
10. Presiona **Crear promoción**.

> Los criterios se suman con **Y**: "Activo" + sede "Yopal" alcanza solo a los activos de Yopal. Dentro de un mismo criterio se suman con **O**: "Activo" y "Cartera" alcanza a los de cualquiera de los dos estados.

**Paso a paso (editar, ver la bitácora o eliminar):**

1. En cada tarjeta, usa el ícono de reloj para ver los cambios de su público, el lápiz para editar y la basura para eliminar (pide confirmación).
2. Si la promoción ya se aplicó, el enlace "N aplicación(es)" abre la lista de facturas descontadas: a qué cliente, cuánto y quién la aplicó.

> Una promoción **Programada** es la que está activa pero con fecha de inicio futura: aún no se puede aplicar. Una **Vigente** es la que está dentro de su rango de fechas y sí se puede aplicar.
