# Subdominio del saves nuevo — `app.saves.com.co`

Un solo subdominio sirve **todo el sistema nuevo** (front + API + webhook):

- `https://app.saves.com.co/`                    → **frontend** (Next.js, `127.0.0.1:3060`)
- `https://app.saves.com.co/api/...`             → **API** (NestJS, `127.0.0.1:3061`)
- `https://app.saves.com.co/api/whatsapp/webhook` → **webhook de Kapso**

Al estar front y API en el **mismo origen**, no hay problemas de CORS.

- **Servidor (IPv4):** `89.117.146.226`
- **Verify token webhook:** `b7dcf100-5c8e-4a26-931a-cbf09ea91e91`

---

## 1) DNS en HostGator

Registro **A**:

| Tipo | Nombre / Host | Valor            | TTL  |
|------|---------------|------------------|------|
| A    | `app`         | `89.117.146.226` | 3600 |

(FQDN: `app.saves.com.co`.) Espera propagación: `ping app.saves.com.co` → `89.117.146.226`.

---

## 2) Subdominio en Plesk

Plesk → **Websites & Domains** → `saves.com.co` → **Add Subdomain** → nombre `app`.

---

## 3) SSL (Let's Encrypt) en Plesk

Subdominio `app.saves.com.co` → **SSL/TLS Certificates** → **Install a free basic
certificate (Let's Encrypt)** → marcar el dominio → **Get it free**.
(Requiere el DNS del paso 1 ya propagando.)

---

## 4) Reverse proxy — **Apache**, no nginx  ✅ HECHO (2026-07-19)

> ⚠️ Este servidor **no usa nginx**: el servicio está caído y Plesk no lo gestiona
> (no existe `/etc/nginx/plesk.conf.d/vhosts/`). Apache es dueño de 80/443. Un
> `vhost_nginx.conf` aquí **no lo lee nadie**.

Las directivas van en **los dos** archivos del vhost — Plesk incluye `vhost.conf`
solo en el vhost HTTP y `vhost_ssl.conf` solo en el HTTPS:

- `/var/www/vhosts/system/app.saves.com.co/conf/vhost.conf`
- `/var/www/vhosts/system/app.saves.com.co/conf/vhost_ssl.conf`

```apache
<IfModule mod_proxy.c>
    ProxyRequests Off
    ProxyPreserveHost On
    ProxyTimeout 60

    RequestHeader set X-Forwarded-Proto "https"

    # API (NestJS :3061) — primero, gana sobre "/"
    ProxyPass        /api/  http://127.0.0.1:3061/api/
    ProxyPassReverse /api/  http://127.0.0.1:3061/api/

    # Frontend (Next.js :3060)
    ProxyPass        /  http://127.0.0.1:3060/
    ProxyPassReverse /  http://127.0.0.1:3060/
</IfModule>
```

Aplicar (requiere sudo):

```bash
sudo plesk sbin httpdmng --reconfigure-domain app.saves.com.co
sudo apachectl configtest && sudo systemctl reload apache2
```

`httpdmng` **respeta** `vhost.conf`/`vhost_ssl.conf` (a diferencia de
`vhost_nginx.conf`, que regenera). Comprobar que quedaron incluidos:

```bash
sudo grep -n "vhost.*conf" /var/www/vhosts/system/app.saves.com.co/conf/last_httpd.conf
```

**Síntoma de que falta esto:** la URL responde 200 pero muestra la *"Domain Default
page"* de Plesk. Si solo pusiste `vhost.conf`, HTTP funciona y **HTTPS sigue en la
página de Plesk**.

---

## 5) Switch del frontend  ✅ HECHO (2026-07-19)

En `frontend/.env.local`:

```
NEXT_PUBLIC_API_URL=https://app.saves.com.co/api
```

y reconstruyo (`npm run build` + `pm2 restart saves-frontend`). Después la app se
entra por `https://app.saves.com.co`. (El backend CORS ya incluye ese origen.)

---

## 6) Configurar en Kapso

Panel de Kapso → número conectado → **URL de reenvío del webhook**:
`https://app.saves.com.co/api/whatsapp/webhook`
Verify token: `b7dcf100-5c8e-4a26-931a-cbf09ea91e91`

(En Meta ya quedó: callback = `https://meta-webhooks.kapso.ai/whatsapp`,
verify token = el mismo.)

---

## 7) Verificar

```bash
# Frontend responde por HTTPS
curl -I https://app.saves.com.co

# Webhook handshake (debe devolver "hola123")
curl "https://app.saves.com.co/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=b7dcf100-5c8e-4a26-931a-cbf09ea91e91&hub.challenge=hola123"
```

---

### Notas
- pm2 debe seguir corriendo: `saves-frontend` (:3060) y `saves-backend` (:3061).
- Firma de webhooks: `WHATSAPP_WEBHOOK_APP_SECRET` del `.env` debe coincidir con
  el secreto que firma en Kapso/Meta.
- Orden de locations: nginx usa el prefijo más largo, así que `/api/` gana sobre
  `/` sin importar el orden.
