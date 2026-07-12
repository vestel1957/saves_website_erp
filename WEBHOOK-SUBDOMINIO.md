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

## 4) Reverse proxy (nginx) en Plesk

Subdominio → **Apache & nginx Settings**:

1. **Desmarcar** “Smart static files processing” y “Serve static files directly
   by nginx” (así nginx no intenta servir archivos y pasa todo a los proxies).
2. En **Additional nginx directives**, pegar:

```nginx
# API (NestJS, prefijo /api) — sin barra final en proxy_pass: conserva /api
location /api/ {
    proxy_pass http://127.0.0.1:3061;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    client_max_body_size 30m;   # subir archivos (documentos, import Excel)
}

# Frontend (Next.js)
location / {
    proxy_pass http://127.0.0.1:3060;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

3. **Apply**.

> Si Plesk se queja de *duplicate location "/"*, además **desactiva “Proxy mode”**
> (el reenvío a Apache) en esa misma pantalla y vuelve a aplicar.

---

## 5) Avisarme para el switch del frontend (lo hago yo)

El frontend hoy apunta a `http://89.117.146.226:3061/api` (IP). Cuando el
subdominio ya resuelva con SSL, yo cambio en `frontend/.env.local`:

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
