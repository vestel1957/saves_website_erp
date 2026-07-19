# Manual de Técnicos

Este manual es para el personal **Técnico** de Vestel (Soporte y Red): las personas que atienden las fallas de los clientes y operan los equipos de la red (fibra, routers, cajas en los postes). Todo se hace desde el sistema **SAVES**. Aquí encontrarás, pantalla por pantalla, dónde está cada cosa, para qué sirve y el paso a paso. No necesitas saber de redes para seguirlo: cada palabra técnica se explica la primera vez que aparece y hay un glosario al inicio.

> Regla de oro: algunas pantallas pueden **apagar o encender el servicio real** de un cliente, o reiniciar/borrar un aparato en su casa. Cuando una acción afecta el servicio real, el manual te lo advierte. Léelo con calma antes de pulsar.

---

## Glosario rápido

Lee esto una vez; después el resto del manual se entiende mucho mejor.

| Término | En palabras sencillas |
| --- | --- |
| **Cliente / Abonado** | La persona que paga el internet o la TV. "Abonado" es su número de cuenta dentro de Vestel. |
| **Sede** | Cada oficina/zona de Vestel. Casi todo se filtra por sede. |
| **Fibra óptica** | El cable de vidrio delgadísimo que lleva el internet por la calle hasta la casa. |
| **NAP** | La cajita que va en el poste y reparte la fibra a varias casas. De ahí sale un "hilo" de fibra para cada cliente. Cada salida se llama **puerto**. |
| **Puerto (de NAP)** | Una de las salidas de la caja NAP. Puede estar **libre** (sin cliente) u **ocupado** (asignado a un cliente). |
| **ONU** | El aparato de fibra que se instala **dentro de la casa** del cliente. Recibe la fibra y entrega internet. También se le dice "cablemódem" u "ONT". |
| **OLT** | El equipo **central** de fibra (está en la sede/nodo de Vestel). Manda a todas las ONU de un sector. Desde la OLT se **autoriza** (da de alta) o se controla una ONU. |
| **SN (Serial Number / Serial)** | El número único de fábrica de una ONU. Sirve para identificarla en la OLT. |
| **F/S/P (Frame / Slot / Puerto)** | La "dirección" física de una ONU dentro de la OLT: en qué bastidor (frame), en qué tarjeta (slot) y en qué puerto está conectada. |
| **Autofind** | Lista de ONU que la OLT "ve" recién conectadas pero que **todavía no están autorizadas**. Autenticarlas es darles de alta. |
| **RX / dBm** | La **potencia de la señal óptica** que le llega a la ONU, medida en dBm. Entre más negativo el número, más débil. Muy débil = fallas o cortes. |
| **Mikrotik / RouterOS** | El **router** de Vestel que controla las conexiones de internet de los clientes por fibra/red. RouterOS es su sistema. Desde ahí se corta o reconecta el internet. |
| **PPPoE** | La forma en que el cliente "inicia sesión" para tener internet, con un usuario y contraseña que vive en el Mikrotik. |
| **Secret (PPPoE)** | El registro dentro del Mikrotik con el usuario/contraseña de un cliente. **Deshabilitar el secret = cortarle el internet.** |
| **Sesión activa** | Un cliente que **en este momento** está conectado y navegando. |
| **Perfil (PPP)** | La plantilla de velocidad de un plan (ej.: 100 megas). Define cuánta velocidad recibe el secret. |
| **Pool de IP** | El rango de direcciones IP que el Mikrotik reparte a los clientes. |
| **CPE** | Nombre general del equipo del cliente (la ONU, el módem, el router de su casa). |
| **TR-069 / GenieACS** | TR-069 es un estándar para administrar los CPE **a distancia**. GenieACS es el programa que lo hace. Con esto Vestel corta o activa, por ejemplo, la **TV** de un cliente sin ir a su casa. |
| **Inform** | El "saludo" que cada CPE le manda al servidor GenieACS cada cierto tiempo. Si un CPE lleva muchos días sin dar inform, probablemente está apagado o desconectado. |
| **Dry-run (simulación)** | Modo de práctica: el sistema **calcula lo que haría pero NO lo hace**. Sirve para revisar sin riesgo. En este modo nada le pasa al cliente de verdad. |
| **Modo LIVE (real)** | Lo contrario del dry-run: las acciones **sí** se ejecutan contra los equipos de producción y **sí** afectan al cliente. |
| **Bodega / Almacén** | El lugar donde se guardan los equipos (ONU, routers) antes de instalarlos. |
| **Transferencia** | El movimiento de equipos de una bodega a otra o hacia el técnico. |

> Sobre el modo dry-run: casi todas las pantallas de Red y Mikrotik muestran una etiqueta arriba. Si dice **"DRY-RUN (simulación)"** en azul, estás en modo práctica y nada real se toca. Si dice **"MODO LIVE"** en rojo, cuidado: **lo que hagas afecta al cliente**. Cuando estés en LIVE, el sistema te pedirá **confirmar** antes de cortar, reiniciar o borrar.

### Cosas que verás en casi todas las pantallas

- **El menú solo muestra lo que puedes usar.** Si no ves una opción, es porque tu usuario no tiene ese permiso. No es un error.
- **Buscador:** casi todas las listas tienen una barra para buscar por nombre, código, cliente, etc. Escribe y la lista se filtra sola.
- **Aviso al guardar:** cuando guardas algo, aparece un mensaje corto. **Verde** = salió bien. **Rojo** = algo falló (el mensaje dice qué).
- **Filtros por sede/estado:** las listas grandes se acotan con menús desplegables (sede, estado, etc.).

---

# Soporte

## Soporte técnico (listado y ficha de una orden)

**Dónde:** menú **Soporte** (`/soporte`).

**Para qué sirve:** es el tablero de todas las **órdenes de trabajo** (también llamadas casos o tickets): instalaciones, fallas, cortes, reconexiones. Desde aquí abres la orden que te toca, la documentas, subes fotos, registras el material y el equipo que usaste, generas el PDF de la orden y recoges la firma del cliente.

**Qué vas a ver (lista de órdenes):**

| Columna | Qué significa |
| --- | --- |
| N° | Número de la orden. |
| Prioridad | Qué tan urgente es (Alta, Media, Baja). |
| Orden | El tipo de trabajo y el asunto. |
| Descripción | Resumen del problema. |
| Usuario | El cliente. Al hacer clic vas a su ficha. |
| Sede / Barrio | Dónde está el cliente. |
| Técnico | A quién está asignada (círculo con iniciales). "Sin asignar" si no tiene. |
| Creada | Fecha en que se abrió. |
| Estado | Pendiente, Realizando, Resuelto o Anulada. |

**Paso a paso — encontrar y abrir tu orden:**

1. Usa el buscador (arriba) para escribir el nombre del cliente, el técnico o el número de orden.
2. Ajusta los filtros: **estado**, **técnico** (elige tu nombre para ver solo las tuyas), **tipo de detalle**, **sede** y **prioridad**.
3. Para acotar por fechas, pulsa **Fechas**: elige un periodo, o usa los atajos "Hoy", "7 días", "Este mes", o "Histórico completo".
4. Haz clic en la fila de la orden para abrirla.

**Paso a paso — crear una orden nueva:**

1. Pulsa **Nueva orden** (arriba a la derecha).
2. Llena los datos del formulario y guarda.

**Paso a paso — trabajar dentro de una orden (su ficha):**

1. **Revisa la información del cliente:** nombre, documento, abonado, celular, dirección, barrio, sede, servicios contratados, equipo asignado y la **deuda actual** (en rojo si debe). Si hay **coordenadas**, el enlace "Abrir en Maps" te lleva a la ubicación.
2. **Asigna el técnico** (si falta): en "Asignar técnico" elige el nombre y pulsa **Guardar**.
3. **Cambia la prioridad** si aplica, con el selector de la esquina superior derecha.
4. **Cambia el estado** con los botones de arriba (Pendiente → Realizando → Resuelto). El botón rojo **Anulada** cancela la orden.
5. **Registra el equipo instalado:** en el bloque "Equipo y material" pulsa **Asignar equipo** y elige la ONU/equipo que instalaste en la casa.
6. **Registra el material usado:** pulsa **Registrar material** (conectores, cable, etc.). Esto **descuenta ese material del stock** de la bodega automáticamente.
7. **Documenta el avance / solución:** en "Seguimiento" elige una **solución/causa** de la lista (opcional) y escribe la explicación. Pulsa **Documentar**.
8. **Sube una foto de evidencia:** pulsa **Adjuntar foto** (en el celular abre la cámara), y luego **Subir evidencia**. El sistema intenta guardar también la **ubicación** de la foto.
9. **Recoge la firma del cliente:** en "Firma de quien recibe" escribe el nombre, la cédula y el parentesco de quien recibe, dibuja la firma con el dedo en el recuadro y pulsa **Guardar firma**.
10. **Genera el PDF:** pulsa **Orden PDF** (arriba a la derecha) para abrir la orden de trabajo lista para imprimir o enviar.

> El material que registras **se descuenta del stock** de verdad. Registra solo lo que realmente usaste, con la cantidad correcta.

> La **ubicación de la foto** solo se guarda si el celular está en un sitio con conexión segura (HTTPS). Sobre conexión normal (HTTP) la foto sí sube, pero sin coordenadas; el sistema te lo avisa. Cuando hay ubicación, en el seguimiento verás a cuántos metros del cliente se tomó la foto (verde si está cerca, ámbar si está lejos).

---

# Red / ISP

> Recuerda: las pantallas de esta sección muestran arriba la etiqueta **DRY-RUN (simulación)** o **MODO LIVE**. En LIVE, las acciones sobre ONU y equipos afectan el servicio real. Confirma siempre antes de reiniciar o eliminar.

## Conexiones

**Dónde:** menú **Red → Conexiones** (`/red/conexiones`).

**Para qué sirve:** ver y administrar los **puertos de las cajas NAP** (las salidas de fibra en los postes). Aquí sabes qué puerto está libre, cuál está ocupado y por qué cliente, y puedes **asignar** un cliente a un puerto o **liberar** un puerto.

**Qué vas a ver:**

| Columna | Qué significa |
| --- | --- |
| Puerto | El número de salida de la NAP. |
| NAP | La caja a la que pertenece. |
| Estado | **Disponible** (libre) u **Ocupado**. |
| Cliente | El abonado que usa ese puerto (o "— libre"). |
| Acción | **Asignar** (si libre) o **Liberar** (si ocupado). |

Arriba verás un resumen: cuántos puertos hay, cuántos ocupados y cuántos libres.

**Paso a paso — asignar un cliente a un puerto:**

1. Filtra por **sede** y por **NAP** para llegar rápido al puerto (o usa el buscador).
2. En un puerto **Disponible**, pulsa **Asignar**.
3. Busca y elige el cliente en el buscador de la ventana.
4. Pulsa **Asignar**. Verás el aviso verde de confirmación.

**Paso a paso — liberar un puerto:**

1. En un puerto **Ocupado**, pulsa **Liberar**.
2. El puerto queda **Disponible** para otro cliente.

> Liberar un puerto lo desocupa en el sistema. Hazlo solo cuando el cliente ya no usa esa salida de fibra (retiro, traslado), para no dejar a alguien sin registro de su conexión.

## Cajas NAP

**Dónde:** menú **Red → Cajas NAP** (`/red/naps`).

**Para qué sirve:** administrar las **cajas NAP** (las que reparten la fibra en los postes), organizadas por sede. Puedes ver cuántos puertos tiene cada caja, cuántos ya están registrados, y **crear** una NAP nueva.

**Cómo se navega:** primero eliges una **sede** (la pantalla muestra la lista de sedes con cuántas cajas tiene cada una). Al entrar a una sede ves sus cajas NAP.

**Qué vas a ver (dentro de una sede):**

| Columna | Qué significa |
| --- | --- |
| NAP | Nombre de la caja. |
| VLAN | Etiqueta de red interna que usa la caja (si tiene). |
| Puertos | Cuántos puertos están registrados de cuántos hay en total (ej.: 8/16). |
| Dirección | Poste o referencia donde está instalada. |

**Paso a paso — abrir las cajas de una sede:**

1. En la lista de sedes, escribe en "Buscar sede…" o haz clic en la sede.
2. Verás sus cajas NAP. Ordénalas por **Nombre** o por **VLAN** si quieres.
3. Haz clic en una caja para ver su detalle.
4. Para volver a la lista de sedes, usa la flecha **←** de arriba a la izquierda.

**Paso a paso — crear una caja NAP nueva:**

1. Dentro de una sede, pulsa **Nueva NAP**.
2. Escribe el **Nombre** (ej.: NAP-01) y la cantidad de **Puertos** (entre 1 y 256; normalmente 8 o 16).
3. Elige la **VLAN** si aplica (o déjalo en "Sin VLAN").
4. Opcional: escribe las coordenadas **GPS** (formato "latitud, longitud") y la **Dirección** (poste o referencia).
5. Pulsa **Crear NAP**. La caja queda creada con sus puertos listos para asignar clientes.

## Gestión OLT

**Dónde:** menú **Red → Gestión OLT** (`/red/olt`).

**Para qué sirve:** administrar las **OLT** (los equipos centrales de fibra) y, dentro de cada una, controlar las **ONU** de los clientes: verlas, medir su señal, **autenticarlas** (darlas de alta), reiniciarlas o eliminarlas.

**Qué vas a ver (panel principal):** en la parte de arriba, unos recuadros con el resumen de todas las ONU: **totales, online (encendidas), offline (apagadas), señal débil, señal crítica y sin cliente**. Debajo, la lista de OLT registradas con su marca, IP y estado.

**Paso a paso — probar y entrar a una OLT:**

1. En la lista, pulsa el ícono del rayo (**Probar conexión**) para verificar que la OLT responde. Verás un aviso verde (OK) o rojo (sin conexión).
2. Haz clic en la fila de la OLT (o el ícono ▶ **Operar**) para entrar a operarla.

**Dentro de una OLT — pestañas:**

| Pestaña | Para qué sirve |
| --- | --- |
| Resumen | Modelo, versión y tiempo encendido de la OLT. |
| Tableros | Las tarjetas (slots) de la OLT y su estado. |
| ONUs por puerto | Lista de las ONU conectadas a un slot/puerto: su señal y estado. |
| Autofind | ONU nuevas detectadas que **falta autenticar**. |
| Buscar SN | Buscar una ONU por su serial. |
| Sincronizar | Actualizar el inventario local de ONU desde la OLT. |
| Historial | Registro de lo que se ha hecho (con modo dry-run o live). |

> Cuando el sistema consulta la OLT verás abajo "Consultando la OLT por SSH…". Es normal: la OLT se lee en vivo y puede tardar unos segundos.

**Paso a paso — dar de alta (autenticar) una ONU nueva:**

1. Entra a la pestaña **Autofind** y pulsa **Buscar**. Aparecerán las ONU recién conectadas que esperan autorización, con su **serial (SN)** y su posición **F/S/P**.
2. En la ONU que quieres dar de alta, pulsa **Autenticar**.
3. Completa los datos que pide la ventana (según la sede/plan) y confirma.

**Paso a paso — ver las ONU de un puerto y medir señal:**

1. Ve a la pestaña **ONUs por puerto**.
2. Escribe **Frame**, **Slot** y **Puerto** y pulsa **Listar ONUs** (también puedes llegar aquí desde "Tableros → Ver ONUs").
3. En la lista mira la columna **RX (dBm)**: es la señal. Si sale en rojo, la señal está crítica (probable causa de la falla del cliente).
4. Con los botones de cada ONU: el ojo muestra el **detalle**, la flecha circular la **reinicia**, el bote la **elimina**.

> **Reiniciar** o **eliminar** una ONU afecta el servicio del cliente en su casa. En **MODO LIVE** el sistema te pedirá confirmar mostrándote el serial y la posición de la ONU. En **DRY-RUN** solo se genera el "plan" y **no se toca** el equipo real. Nunca elimines una ONU sin estar seguro: eliminarla deja al cliente sin internet hasta volver a autenticarla.

**Paso a paso — sincronizar el inventario:**

1. Ve a la pestaña **Sincronizar**, escribe el **Slot GPON** y pulsa **Sincronizar slot**.
2. El sistema recorre ese slot y actualiza la lista local de ONU (visible en el Inventario de ONU).

## GenieACS · TR-069

**Dónde:** menú **Red → GenieACS · TR-069** (`/red/genieacs`).

**Para qué sirve:** administrar **a distancia** los equipos del cliente (CPE) por el estándar **TR-069**. En Vestel se usa principalmente para **cortar o restaurar la TV** de varios clientes a la vez, sin ir a sus casas.

**Qué vas a ver:** una lista de CPE (equipos de clientes) con:

| Columna | Qué significa |
| --- | --- |
| Abonado (PPPoE) | El usuario del cliente. Un ícono rojo indica TV suspendida. |
| Marca / Modelo | Qué equipo es. |
| Serial | Número del equipo. |
| IP WAN | La dirección con la que sale a internet. |
| Último inform | Hace cuánto el equipo "saludó" al servidor (si lleva muchos días, está apagado/desconectado). |
| TV | **Activa** o **Suspendida**. |

**Paso a paso — cortar o restaurar TV a varios clientes:**

1. Usa el buscador y los filtros (**estado**, **marca**, **modelo**) para encontrar los clientes.
2. Marca la casilla de cada CPE que quieras. Puedes marcar la página entera con la casilla del encabezado. **La selección se mantiene aunque cambies de página o de filtro** (arriba se muestra cuántos llevas seleccionados y cuántos están fuera de la página visible).
3. En la barra azul de selección pulsa **Cortar TV** (rojo) o **Restaurar TV**.
4. Revisa la ventana de confirmación: muestra la **lista de clientes afectados**. Si algunos no se ven en la página actual, te lo avisa.
5. Confirma.

> Esta es una acción **masiva y sensible**: puede cortar la TV a decenas de clientes de un golpe. Revisa bien la lista de la confirmación antes de aceptar. Si arriba dice **DRY-RUN**, solo se calcula el plan y **no** se toca nada real; el mensaje lo aclara. En **MODO LIVE** el corte se aplica de verdad.

> La etiqueta **"NBI sin auth"** (en ámbar) avisa que el servidor GenieACS no tiene contraseña de acceso configurada. Repórtalo; no actives el modo real hasta asegurarlo.

---

# Mikrotik (routers de la red)

> El **Mikrotik** es el router que controla el internet de los clientes por PPPoE (usuario/contraseña). **Deshabilitar el secret de un cliente = cortarle el internet.** Estas pantallas muestran arriba **DRY-RUN** o **MODO LIVE**. En LIVE, cortar/reconectar afecta al cliente de verdad y el sistema pide confirmación.

## Gestión de routers

**Dónde:** menú **Mikrotik** (`/mikrotik`).

**Para qué sirve:** administrar los routers **Mikrotik** de Vestel: ver si están en línea, probar su conexión, agregar uno nuevo, editarlo o eliminarlo, y entrar a operarlo.

**Qué vas a ver:**

| Columna | Qué significa |
| --- | --- |
| Nombre | Nombre del router (bandera = router por defecto de su sede). |
| IP:Puerto | Dirección para conectarse a él. |
| Tecnología / Sede | A qué corresponde. |
| Usuario | Usuario con el que el sistema entra al router. |
| Estado | En línea o Desconocido. |

**Paso a paso:**

1. Pulsa el ícono del rayo de una fila (**Probar conexión**) para ver si responde; o **Validar todas** para probarlas una por una.
2. Para agregar un router, pulsa **Agregar Mikrotik** y llena los datos (nombre, IP, puerto, usuario, sede).
3. Con los íconos de cada fila puedes **Editar** (lápiz), marcar **por defecto** de la sede (bandera) o **Eliminar** (bote).
4. Haz clic en la fila o el ícono de engranaje (**Operar**) para entrar a administrarlo.

> **Eliminar** un Mikrotik no se puede deshacer. Hazlo solo si estás seguro.

## Operar un router (detalle)

**Dónde:** menú **Mikrotik → (clic en un router)** (`/mikrotik/[id]`).

**Para qué sirve:** ver y administrar en vivo el router: sus conexiones de clientes, quién está conectado ahora, las IP y los perfiles de velocidad.

**Pestañas:**

| Pestaña | Para qué sirve |
| --- | --- |
| Resumen | Cuántos secrets (clientes) hay, cuántas sesiones activas, y datos del router (modelo, RouterOS, uptime, CPU). |
| Secrets PPPoE | La lista de clientes del router: buscar, y **habilitar/deshabilitar** su internet. |
| Sesiones activas | Quién está conectado **ahora** (IP, tiempo, MAC); puedes **cerrar** una sesión. |
| IPs | Las IP asignadas, cuáles están online/offline y **cuáles están en conflicto** (misma IP en dos clientes). |
| Perfiles | Los planes de velocidad (rate-limit). |
| Historial | Registro de las acciones hechas (dry-run/live y quién). |

**Paso a paso — cortar o reconectar el internet de un cliente desde aquí:**

1. Entra a la pestaña **Secrets PPPoE** y busca al cliente por usuario, IP o comentario.
2. En su fila, pulsa el botón de encender/apagar (toggle): **Deshabilitado = sin internet**, **Habilitado = con internet**.
3. En **MODO LIVE** el sistema te pide confirmar antes de tocar el router real. En **DRY-RUN** solo muestra el "plan" y no corta de verdad.

**Paso a paso — cerrar la sesión de un cliente conectado:**

1. Entra a **Sesiones activas** y ubica al cliente.
2. Pulsa el ícono de encendido (**Cerrar sesión**). Esto lo desconecta; volverá a conectarse solo si su secret sigue habilitado.

> Si en la pestaña **IPs** ves filas resaltadas en rojo con "IP en conflicto", significa que **dos clientes tienen la misma IP**, lo que causa cortes intermitentes. Repórtalo o corrígelo: es una causa común de fallas raras.

## Operaciones masivas

**Dónde:** menú **Mikrotik → Operaciones masivas** (`/mikrotik/masivo`).

**Para qué sirve:** cortar, reconectar o enviar WhatsApp a **muchos clientes a la vez**, por sede (por ejemplo, cortar a todos los morosos de una sede). También permite **restaurar los secrets** de una sede tras formatear un Mikrotik.

**Cómo se navega:** primero eliges una **sede** (cada tarjeta muestra cuántos clientes tiene, cuántos activos, cortados y en cartera). Luego ves sus clientes y los filtras.

**Paso a paso — corte o reconexión masiva:**

1. Elige la **sede** (o "Ver todas las sedes juntas").
2. Usa los filtros para acotar: **estado del cliente**, **servicio** (internet/TV/combo), **estado de cuenta** (al día/debe/compromiso), **deuda** (1 mes / más de 2 meses), **tecnología** y el buscador.
3. Marca los clientes con las casillas. Si quieres operar sobre **todos los que cumplen el filtro** (no solo los que se ven en pantalla), usa el enlace **"Seleccionar los N que cumplen el filtro"**.
4. En la barra de acciones pulsa **Cortar** (rojo), **Reconectar** o **WhatsApp**.
5. Para cortar, confirma en la ventana (te dice a cuántos clientes afecta).

**Paso a paso — enviar WhatsApp masivo:**

1. Con clientes seleccionados, pulsa **WhatsApp**.
2. Ajusta el mensaje. Puedes usar `{nombre}` y `{abonado}`, que se reemplazan por los datos de cada cliente.
3. Pulsa **Enviar**.

**Paso a paso — restaurar secrets de una sede (tras formatear un Mikrotik):**

1. Dentro de una sede, pulsa **Restaurar secrets**.
2. Confirma. El sistema **recrea o actualiza** en el Mikrotik el secret de cada abonado activo/cortado. Respeta el modo dry-run.

> El corte masivo apaga el internet de **muchos** clientes de una vez. Revisa el número que muestra la confirmación y asegúrate de que el filtro es el correcto. Si dice **(dry-run)** en el resultado, fue una simulación; sin esa marca, el corte fue **real**.

## IPs de usuarios

**Dónde:** menú **Mikrotik → IPs de usuarios** (`/mikrotik/ips`).

**Para qué sirve:** administrar los **pools de IP** (los rangos de direcciones que el Mikrotik reparte a los clientes) y los **perfiles PPPoE** disponibles en cada uno.

**Qué vas a ver:**

| Columna | Qué significa |
| --- | --- |
| Pool | Nombre del rango (bandera "Predeterminado" si es el de la sede). |
| Sede / Tecnología | A qué corresponde. |
| IP local / IP remota | El rango de direcciones. |
| Perfiles | Cuántos perfiles de velocidad tiene. |

**Paso a paso:**

1. Busca por nombre, IP o tecnología.
2. Pulsa **Nuevo pool** para crear uno, o el lápiz para **editar**.
3. Con la bandera marcas un pool como **predeterminado** de la sede (solo puede haber uno).

> Cambiar los pools afecta cómo se reparten las IP a los clientes. Modifícalos solo si sabes lo que haces o te lo indican.

---

# Equipos

## Administrar equipos

**Dónde:** menú **Red → Equipos** (`/red/equipos`).

**Para qué sirve:** el **inventario de equipos** que se instalan en casa del cliente (ONU, routers, CPE). Aquí buscas un equipo, ves dónde está (bodega o cliente), registras uno nuevo e imprimes su etiqueta con código QR.

**Qué vas a ver:**

| Columna | Qué significa |
| --- | --- |
| Código | Código interno del equipo. |
| Marca / MAC / Serial | Datos de identificación. |
| Almacén | En qué bodega está. |
| Asignado a | El cliente que lo tiene (o "— disponible"). |
| ACS | Si está administrado por GenieACS. |
| Estado | Disponible, Asignado o Instalado. |

**Paso a paso:**

1. Busca por **código, MAC, serial o marca**. También puedes filtrar por **asignados/disponibles** y por **almacén**.
2. Para registrar un equipo nuevo, pulsa **Nuevo equipo** y llena el formulario.
3. Para imprimir la etiqueta con QR de un equipo, pulsa **Etiqueta** en su fila. (Al escanear ese QR, el sistema busca el equipo por su código automáticamente.)

## Bodegas de equipos

**Dónde:** menú **Red → Bodegas** (`/red/bodegas`).

**Para qué sirve:** ver los **almacenes** de equipos por sede y cuántos equipos hay en cada uno. Al abrir una bodega ves su contenido.

**Qué vas a ver:** arriba, el total de equipos en bodega y el número de bodegas. Debajo, la lista de bodegas con su nombre, descripción y cuántos equipos tiene cada una.

**Paso a paso:**

1. Revisa la lista de bodegas.
2. Haz clic en una fila (**Ver equipos**) para entrar y ver los equipos que contiene.

## Transferencias de equipos

**Dónde:** menú **Red → Transferencias** (`/red/transferencias`).

**Para qué sirve:** mover equipos de una bodega a otra (o hacia el técnico). El movimiento tiene tres pasos: alguien **solicita**, inventario **despacha** (aprueba) y la sede destino (caja) **confirma la recepción**.

**Qué vas a ver:**

| Columna | Qué significa |
| --- | --- |
| Fecha | Cuándo se solicitó. |
| Origen → Destino | De qué bodega a qué bodega. |
| # Equipos | Cuántos equipos incluye. |
| Solicita | Quién la pidió. |
| Estado | Pendiente, En tránsito, Recibida o Rechazada. |

**Paso a paso — solicitar una transferencia:**

1. Pulsa **Solicitar transferencia**.
2. Elige la **bodega origen** y la **bodega destino** (deben ser distintas).
3. Marca los **equipos** que quieres mover (aparecen los de la bodega origen).
4. Opcional: escribe **observaciones**.
5. Pulsa **Crear transferencia**. Queda **Pendiente** de aprobación.

**Paso a paso — ver o gestionar una transferencia:**

1. Pulsa **Ver** en la fila. Se abre el detalle con el flujo: quién la solicitó, quién la despachó y quién la recibió.
2. Según tu permiso y el estado:
   - Si está **Pendiente** y eres jefe de bodega (inventario): **Aprobar y despachar** (los equipos salen de origen y quedan en tránsito) o **Rechazar** (con motivo).
   - Si está **En tránsito** y recibes en la sede destino (caja): **Confirmar recepción** (los equipos entran a la bodega destino).

> Los estados avanzan solos según cada persona actúe. Como técnico normalmente **solicitas** la transferencia; aprobar/despachar y recibir dependen de otros roles (inventario y caja). Si no ves esos botones, es porque tu usuario no tiene ese permiso.

---

## Cortar y reconectar el servicio de un cliente

Esta es una de las acciones más importantes y **se hace desde la ficha del cliente**, no desde las pantallas de red.

**Dónde:** menú **Clientes → (busca y abre el cliente)** → botón **Acciones** → **Conexión** (`/clientes/[id]`).

**Para qué sirve:** cortar o reconectar el **internet de ese cliente** en su Mikrotik, y ver el estado de su conexión.

**Paso a paso:**

1. Abre la ficha del cliente (desde Clientes, o desde el enlace del nombre del cliente en cualquier lista).
2. Pulsa el botón **Acciones** (arriba a la derecha) y elige **Conexión**.
3. Se abre el panel de **Conectividad — Corte / Reconexión**. Ahí verás el router del cliente y el estado de su secret.
4. Pulsa **Cortar internet** o **Reconectar** según necesites.
5. Revisa el resultado (secret existe / secret activo) y el historial de acciones anteriores.

> **Advertencia — esto afecta el servicio real del cliente.** Fíjate en el aviso del panel:
> - Si dice **MODO REAL (LIVE)**, la acción **corta o enciende de verdad** el internet del cliente. El sistema te pedirá **confirmar** antes de ejecutarla.
> - Si está en **dry-run (simulación)**, la acción solo se calcula y **no** afecta al cliente. El modo real solo se activa con la configuración `MIKROTIK_LIVE=true` en el servidor, por lo que normalmente estás en simulación mientras no se indique lo contrario.
>
> Antes de cortar, verifica que es el cliente correcto y que el corte procede (por ejemplo, por mora). Un corte por error deja a una persona sin servicio.
