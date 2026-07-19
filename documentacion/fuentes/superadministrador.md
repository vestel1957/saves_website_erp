# Manual del Superadministrador

Este manual está dirigido a quien administra el sistema SAVES de Vestel: la persona responsable de crear los usuarios, decidir qué puede ver y hacer cada uno, y vigilar la seguridad. El superadministrador tiene acceso total al sistema, por eso es también quien más cuidado debe tener. Aquí encontrará, en lenguaje sencillo, cómo funciona el modelo de accesos, cómo administrar usuarios y roles, y cómo revisar quién hizo qué.

> Nota general de la interfaz: el menú de la izquierda oculta automáticamente las secciones para las que un usuario no tiene permiso. Si alguien "no ve" una opción, casi siempre es porque le falta el permiso, no porque exista una falla. Además, al guardar cualquier cambio, aparece un aviso verde (correcto) o rojo (hubo un problema).

## Cómo funciona el acceso: áreas y roles

El sistema está organizado en **áreas de trabajo**. Un área es un conjunto de secciones del sistema que corresponden a una función dentro de la empresa (por ejemplo, todo lo de caja, o todo lo de red). Cada usuario ve únicamente las secciones del área (o áreas) que se le hayan asignado; el resto queda oculto en el menú.

La forma de asignar accesos es a través de **roles**. Un rol es simplemente una plantilla de permisos con un nombre: al asignarle un rol a una persona, esa persona hereda de golpe todos los permisos que trae ese rol. Así no hay que marcar permiso por permiso a cada empleado.

Existen seis áreas principales:

| Área | Para quién | Qué puede hacer (resumen) | Al entrar aterriza en |
|---|---|---|---|
| Gerencia | Dirección | Ver panel ejecutivo y reportes (solo lectura) | Dashboard |
| Administración | Operaciones | Clientes, inventario de material, compras, proveedores, personal, proyectos | Clientes |
| Contabilidad | Contabilidad / facturación | Facturas, notas, facturación electrónica, contabilidad | Facturación |
| Caja y ventas | Cajero / cajera | Abrir / cerrar caja, ingresos, egresos, cobrar facturas | Tesorería |
| Técnicos | Soporte y red | Tickets de soporte, red, Mikrotik, OLT, equipos | Soporte |
| Sistemas | TI / configuración | Configuración, WhatsApp, automatizaciones, usuarios | Configuración |

Aclaraciones importantes:

- El **superadministrador ve TODO**. No está limitado a un área: su permiso especial de "acceso total" lo deja pasar cualquier restricción del sistema.
- Un mismo usuario **puede tener más de un área**. Por ejemplo, una persona puede ser a la vez de "Caja y ventas" y de "Administración"; entonces verá las secciones de ambas.
- "Aterriza en" es la pantalla de inicio que ve la persona apenas entra, pensada para que empiece por lo más importante de su trabajo.

> Consejo: piense en el rol como el "cargo" dentro del sistema y en el área como el "piso del edificio" al que ese cargo tiene llave. Asignar el rol correcto suele bastar; los ajustes finos (dar o quitar una pantalla puntual) se hacen después en la ficha del empleado.

## Usuarios y roles

**Dónde:** Menú lateral → CONFIGURACIÓN → Usuarios y roles (ruta `/configuracion/usuarios`).

**Para qué sirve:** es el centro de administración de accesos. Desde aquí crea las cuentas con las que las personas inician sesión, les asigna roles y áreas, activa o desactiva cuentas, y restablece contraseñas cuando alguien la olvida.

**Qué vas a ver:**

- Tres tarjetas de resumen en la parte superior: cantidad de **Usuarios**, cuántos están **Activos** y cuántos **Roles** hay definidos.
- Un buscador para filtrar usuarios por nombre o correo.
- La **lista de usuarios**, con: nombre y correo, los roles que tiene (etiquetas de color), el estado (Activo / Inactivo) y los botones de acción (Editar, Roles, Activar/Desactivar).
- Más abajo, la sección **Roles y permisos**, con los roles agrupados por área. Cada rol es una tarjeta que muestra su descripción y, al desplegarla, la lista de permisos que concede.

**Paso a paso — Crear un usuario:**

1. Presione el botón **Nuevo usuario** (arriba a la derecha).
2. Escriba el **Nombre completo** de la persona.
3. Escriba el **Correo**. Ese correo será su usuario para iniciar sesión.
4. Defina una **Contraseña temporal** (mínimo 8 caracteres). La persona podrá cambiarla después. Use el ícono del ojo para verla mientras la escribe.
5. En **Roles**, despliegue las áreas y marque el o los roles que le corresponden. Puede marcar varios.
6. Presione **Crear usuario**. Aparecerá el aviso verde de confirmación y la persona aparecerá en la lista.

> Advertencia: entregue la contraseña temporal por un canal seguro (en persona, o por un medio privado), nunca en un chat grupal o correo compartido.

**Paso a paso — Asignar rol y área(s) a un usuario existente:**

1. En la fila del usuario, presione el botón **Roles**.
2. En **Rol base (plantilla)**, despliegue las áreas y marque o desmarque los roles. Recuerde: al asignar un rol se heredan automáticamente todos sus permisos.
3. Si necesita afinar, en **Acceso a módulos y pantallas** puede marcar pantallas adicionales o quitar algunas que trae el rol. Estos cambios se guardan como **excepciones** propias de esa persona (se marcan como "+ extra" o "revocado").
4. Presione **Guardar cambios**.

**Paso a paso — Editar datos o restablecer el acceso (contraseña):**

1. En la fila del usuario, presione el botón **Editar**.
2. Para corregir datos: cambie **Nombre** o **Correo** y presione **Guardar datos**.
3. Para restablecer el acceso: en **Restablecer contraseña**, escriba una contraseña nueva (mínimo 8 caracteres) y presione **Restablecer contraseña**. Compártala con la persona por un canal seguro.

**Paso a paso — Activar o desactivar un usuario:**

1. En la fila del usuario, presione **Desactivar** (si está activo) o **Activar** (si está inactivo).
2. Al desactivar, el sistema pide confirmación: un usuario desactivado **no podrá iniciar sesión** hasta que se le reactive.

> Consejo: desactivar es mejor que borrar. Cuando alguien sale de la empresa, desactive su cuenta de inmediato; así queda sin acceso pero se conserva el historial de lo que hizo.
>
> Nota: usted no puede desactivar su propia cuenta (el botón aparece bloqueado), para evitar quedarse por fuera del sistema por error.

## El constructor de roles

**Dónde:** en la misma pantalla de Usuarios y roles (`/configuracion/usuarios`), sección **Roles y permisos**.

**Para qué sirve:** un rol es una **plantilla de permisos**. En lugar de dar permisos uno por uno a cada empleado, se arma un rol con el conjunto de permisos de un cargo y luego se asigna ese rol a las personas. Cambiar el rol de una persona cambia de golpe todo lo que puede ver y hacer.

Hay dos tipos de roles:

- **Roles del sistema:** vienen predefinidos con SAVES (por ejemplo Gerencia, Administración, Contabilidad, Caja y ventas, Técnicos, Sistemas, Superadministrador). Se identifican con un candado y son de **solo lectura**: no se pueden editar ni borrar. Sí se pueden **clonar** para partir de ellos y crear una versión propia.
- **Roles personalizados:** los que usted crea. Estos sí se pueden **editar** y **borrar**.

**Paso a paso — Crear un rol personalizado:**

1. En la cabecera de la sección **Roles y permisos**, presione **Nuevo rol** (solo aparece para el superadministrador).
2. Escriba el **Nombre del rol** (por ejemplo, "Técnico junior").
3. Elija el **Grupo** donde quiere que aparezca clasificado (por ejemplo "Personalizados").
4. Escriba una **Descripción** breve de para qué sirve.
5. En la lista de **Permisos**, marque los que concederá. Puede usar el filtro para buscar y marcar grupos completos de una vez.
6. Presione **Crear rol**. El nuevo rol quedará disponible para asignarlo a usuarios.

**Paso a paso — Crear un rol a partir de uno existente (clonar):**

1. En la tarjeta del rol que quiere tomar como base, presione **Clonar**.
2. Se abre el constructor con una copia de sus permisos ya marcados.
3. Ajuste nombre, descripción y permisos, y presione **Crear rol**.

> Advertencia: para **eliminar** un rol personalizado no puede tener usuarios asignados. Primero reasigne a esas personas a otro rol; luego el botón de eliminar quedará disponible.

## Permisos en la ficha del empleado

**Dónde:** Menú lateral → ADMINISTRACIÓN → Empleados → abra una persona (ruta `/empleados/[id]`), pestaña **Permisos y accesos**.

**Para qué sirve:** ver, y en su caso ajustar con detalle, qué puede hacer una persona dentro del sistema. Es la vista "por empleado" (mientras que Usuarios y roles es la vista "por cuenta").

**Qué vas a ver:**

- Si el empleado **tiene cuenta** del sistema: los datos de esa cuenta (correo, fecha de creación, último ingreso), los **roles** asignados y un **árbol de permisos** organizado en tres bloques: Módulos del sistema, Pantallas del menú y Áreas de acceso.
- Si el empleado **no tiene cuenta**: un aviso indicándolo. El superadministrador puede crearle el acceso con el botón **Crear acceso al sistema** (requiere que el empleado tenga correo registrado).

**Puntos clave:**

1. **Solo el superadministrador edita permisos.** Los demás usuarios ven la ficha en modo lectura; les aparece el aviso "Solo el superusuario puede editar".
2. **La relación empleado ↔ usuario se hace por el correo.** La ficha del empleado y la cuenta de acceso se vinculan a través del correo. Si cambia el correo de un empleado, revise después esta pestaña para confirmar que sigue vinculado a su cuenta.
3. Desde aquí también puede **crear el acceso**, **habilitar/inhabilitar** la cuenta y **restablecer la contraseña** (se genera una contraseña temporal que se muestra una sola vez: guárdela en ese momento).

**Paso a paso — Ajustar permisos de una persona:**

1. Abra la ficha del empleado y entre a la pestaña **Permisos y accesos**.
2. Presione **Editar permisos**.
3. En **Roles**, agregue o quite roles; al hacerlo, sus permisos se activan o se retiran automáticamente en el árbol.
4. En el árbol, marque o desmarque pantallas y módulos puntuales. Lo que quede distinto de lo que dan los roles se marca como "extra" (añadido) o "del rol" (quitado).
5. Si quiere volver a dejar exactamente lo que dan los roles, use **Restablecer al rol**.
6. Presione **Guardar**.

> Consejo: use los ajustes finos con moderación. Es más fácil de mantener asignar el rol adecuado que llenar a cada persona de excepciones. Si nota que repite las mismas excepciones en varias personas, probablemente convenga crear un rol nuevo.

## Vigilar la seguridad: bitácora y auditoría

**Dónde:** Menú lateral → CONFIGURACIÓN → Bitácora / Auditoría (ruta `/configuracion/actividad`).

**Para qué sirve:** revisar el registro de actividad del sistema, es decir, **quién hizo qué y cuándo**. Es la herramienta principal para vigilar la seguridad, investigar un error o confirmar quién realizó una operación sensible.

**Qué vas a ver:** un listado cronológico de acciones registradas, con la acción realizada, la persona que la hizo y la fecha y hora.

**Paso a paso:**

1. Entre a Bitácora / Auditoría.
2. Recorra el listado de las acciones más recientes.
3. Cruce la información cuando investigue algo: fecha, hora y usuario le indican el responsable de cada movimiento.

> Nota: además de esta bitácora general, la ficha de cada empleado tiene su propia sección **Actividad de accesos**, que muestra los cambios de acceso de esa persona (creación de cuenta, cambios de contraseña, habilitar/inhabilitar). Úsela para auditar un caso concreto.

## Buenas prácticas de seguridad

Como superadministrador, usted es la primera línea de defensa del sistema. Siga estas prácticas:

1. **Acceso mínimo necesario.** Dé a cada persona solo los permisos que su trabajo requiere. No asigne el rol de Superadministrador ni áreas de más "por si acaso"; cada permiso extra es un riesgo extra.
2. **Contraseñas fuertes.** Exija mínimo 8 caracteres y evite claves obvias (nombres, "12345678", el nombre de la empresa). Las contraseñas temporales deben cambiarse pronto.
3. **Revise los accesos cuando alguien sale.** Apenas un empleado deja la empresa o cambia de cargo, desactive o ajuste su cuenta de inmediato. Desactivar conserva el historial; borrar no es necesario.
4. **No comparta usuarios.** Cada persona debe tener su propia cuenta. Las cuentas compartidas hacen imposible saber quién hizo qué en la bitácora y multiplican el riesgo.
5. **Entregue credenciales por canales seguros.** Nunca comparta contraseñas en chats grupales ni correos compartidos.
6. **Revise la bitácora periódicamente.** Un vistazo regular a la actividad ayuda a detectar accesos o cambios inusuales a tiempo.
7. **Proteja su propia cuenta.** Al tener acceso total, su cuenta es la más valiosa: use una contraseña única y fuerte, y no la deje abierta en equipos compartidos.

## Índice de manuales por rol

Cada rol del sistema tiene su propio manual con el detalle de las pantallas que usa en su día a día. Remita a cada persona al manual de su área:

| Área / Rol | Enfoque del manual | Aterriza en |
|---|---|---|
| Gerencia | Panel ejecutivo, indicadores y reportes (solo lectura) | Dashboard |
| Administración | Clientes, inventario de material, compras, proveedores, personal y proyectos | Clientes |
| Contabilidad | Facturas, notas, facturación electrónica y contabilidad | Facturación |
| Caja y ventas | Apertura y cierre de caja, ingresos, egresos y cobro de facturas | Tesorería |
| Técnicos | Tickets de soporte, red, Mikrotik, OLT y equipos | Soporte |
| Sistemas | Configuración, WhatsApp, automatizaciones y administración de usuarios | Configuración |

> Nota: este manual del Superadministrador cubre la administración de usuarios, roles, permisos y seguridad, que es transversal a todas las áreas. Para el detalle operativo de cada sección, consulte el manual del rol correspondiente.
