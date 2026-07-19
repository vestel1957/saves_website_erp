# Asegurar el NBI de GenieACS (basic-auth) antes de activar LIVE

El NBI de GenieACS (API REST, **puerto 7557**) **no trae autenticación propia**: cualquiera
que alcance el puerto puede leer el parque y **encolar tareas** (cortar/restaurar TV, cambiar
parámetros TR-069). Hoy nuestro sistema opera en **DRY-RUN**, así que no toca el ACS; pero
**antes de poner `network.genieacsLive = true` (o `GENIEACS_LIVE=true`)** hay que cerrar ese
puerto. Este runbook cubre las dos formas soportadas.

> El lado de SAVES ya está listo: el cliente NBI manda `Authorization: Basic` cuando el
> servidor tiene usuario/clave, la clave se guarda **cifrada en reposo** (AES-256-GCM,
> `secret-box`), y un rechazo de auth (401/403) sale con mensaje claro en la UI. Sólo falta la
> parte de infra de este documento.

---

## Requisito previo: llave de cifrado

Las credenciales del NBI se cifran con `SECRET_ENC_KEY` (o `AUTH_SECRET` como respaldo). En
producción **es obligatoria** — si falta, el backend aborta el cifrado en vez de usar una llave
débil conocida.

```bash
# genera una llave aleatoria larga y ponla en backend/.env (o en el ecosystem de PM2)
openssl rand -hex 32
# -> SECRET_ENC_KEY=<pega-aquí>
```

`AUTH_SECRET` ya existe en `backend/.env`; si no defines `SECRET_ENC_KEY`, se usa ese. Definir
una llave dedicada es lo recomendado para poder rotarla sin invalidar los tokens de sesión.

> Rotar la llave invalida las claves ya cifradas: tras rotarla hay que **reguardar** la clave
> de cada servidor GenieACS desde la UI (Servidor → escribir la clave → Guardar).

---

## Opción A — Reverse-proxy nginx con basic-auth (recomendada)

Permite seguir accediendo al NBI desde la app aunque estén en hosts distintos, exigiendo
usuario/clave. GenieACS sigue escuchando sólo en localhost; nginx es la única puerta.

### 1. Que GenieACS escuche sólo en localhost

En la config de GenieACS (`genieacs-nbi`), fija la interfaz de escucha del NBI a loopback:

```
GENIEACS_NBI_INTERFACE=127.0.0.1
```

Reinicia el servicio del NBI y confirma que el 7557 ya **no** responde desde fuera del host.

### 2. Crear el archivo de credenciales

```bash
sudo apt-get install -y apache2-utils        # provee htpasswd
sudo htpasswd -c /etc/nginx/genieacs.htpasswd saves     # pide la clave
# para añadir más usuarios luego: htpasswd (sin -c) /etc/nginx/genieacs.htpasswd otro
```

### 3. Bloque de servidor nginx

`/etc/nginx/sites-available/genieacs-nbi` (ajusta `listen`/`server_name` a tu red):

```nginx
server {
    listen 7558;                       # puerto expuesto (protegido). NO expongas el 7557.
    server_name _;

    location / {
        auth_basic           "GenieACS NBI";
        auth_basic_user_file /etc/nginx/genieacs.htpasswd;

        proxy_pass         http://127.0.0.1:7557;   # el NBI real, sólo en loopback
        proxy_set_header   Host $host;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/genieacs-nbi /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> Ideal: además, TLS (poner esto detrás de un `listen 443 ssl` con certificado) para que la
> basic-auth no viaje en claro. Si app y NBI están en el **mismo** host/VPC privada, el proxy
> plano es aceptable como primer cierre.

### 4. Verificar

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://HOST:7558/devices/?limit=1          # -> 401
curl -s -o /dev/null -w "%{http_code}\n" -u saves:CLAVE http://HOST:7558/devices/?limit=1  # -> 200
```

### 5. Apuntar SAVES al proxy

En la app: **Red → GenieACS → Servidor**, edita el servidor:

- **URL del NBI**: `http://HOST:7558` (el puerto **protegido**, no el 7557).
- **Usuario / Password**: los del `htpasswd`.
- Guardar → **Probar conexión** debe dar *Conexión OK con el NBI.*

---

## Opción B — Bind a localhost + túnel SSH (YA operativo en este entorno)

Si la app y el NBI **no** están en el mismo host y no quieres montar nginx, deja el NBI en
loopback y llega por un túnel SSH desde el host de la app.

**En este servidor ya está montado así:** el proceso PM2 `genieacs-tunnel`
(`scripts/genieacs-tunnel.sh`) mantiene un túnel SSH con llave dedicada que reenvía el
**puerto local `17557` → `localhost:7557`** del host del ACS. El NBI remoto sólo escucha en
loopback; nadie lo alcanza sin la llave `~/.ssh/genieacs_tunnel`.

```bash
pm2 describe genieacs-tunnel     # ver estado del túnel
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:17557/devices/?limit=1   # -> 200 desde el host de la app
```

### Apuntar SAVES al túnel

- **URL del NBI**: `http://localhost:17557`
- Usuario/Password: **vacíos** (el túnel ya restringe el acceso a quien tenga la llave SSH).
- Guardar → **Probar conexión** → *Conexión OK.*

> Aquí la seguridad la da SSH, no basic-auth. Es válido, pero el badge de la UI mostrará
> **"NBI sin auth"** porque no hay usuario configurado: es esperado y correcto en este modo.
> Si además quieres basic-auth de extremo a extremo, monta la Opción A en el host del ACS y
> apunta el túnel a ese puerto protegido.

---

## Checklist para activar LIVE

- [ ] `SECRET_ENC_KEY` (o `AUTH_SECRET`) definido en el entorno de producción.
- [ ] El 7557 **no** responde desde fuera del host del ACS (`curl` desde otra máquina falla).
- [ ] Opción A: `curl` sin credenciales → 401; con credenciales → 200.
- [ ] En SAVES, **Probar conexión** da OK y el badge muestra **NBI autenticado** (Opción A).
- [ ] Recién entonces: `network.genieacsLive = true` en Configuración → Red (o `GENIEACS_LIVE=true`).
- [ ] Primer corte/alta real sobre **1 CPE de prueba** y verificar en el historial (auditoría).
