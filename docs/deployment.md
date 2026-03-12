# Deployment Guide

## Production Setup

### 1. System User
```bash
useradd -r -s /bin/false -d /opt/ourtask getrallied
chown -R getrallied:getrallied /opt/ourtask
chmod 600 /opt/ourtask/.env /opt/ourtask/ourtask.db
```

### 2. Systemd Service
```ini
[Unit]
Description=GetRallied Event Registry
After=network.target

[Service]
User=getrallied
Group=getrallied
Type=simple
WorkingDirectory=/opt/ourtask
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/ourtask/.env

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/ourtask
PrivateTmp=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
MemoryMax=512M
TasksMax=50

[Install]
WantedBy=multi-user.target
```

### 3. Nginx (reverse proxy + SSL)
```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    return 301 https://yourdomain.com$request_uri;
}

server {
    listen 443 ssl;
    server_name www.yourdomain.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    return 301 https://yourdomain.com$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location ~ /\. { deny all; }
    location ~ \.(db|env|bak|sql|sh)$ { deny all; }
    location /node_modules { deny all; }
    location /views { deny all; }

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:19100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~* \.(jpg|jpeg|png|gif|ico|css|js|mp4|webp|woff2)$ {
        proxy_pass http://127.0.0.1:19100;
        proxy_set_header Host $host;
        expires 7d;
        add_header Cache-Control "public, no-transform";
    }
}
```

### 4. Database Backups
```bash
# /etc/cron.d/getrallied-backup
0 3 * * * getrallied cp /opt/ourtask/ourtask.db /opt/ourtask/backups/ourtask-$(date +\%Y\%m\%d).db && find /opt/ourtask/backups -name "ourtask-*.db" -mtime +14 -delete
```

### 5. DNS Records (for email deliverability)
| Type | Name | Value |
|------|------|-------|
| TXT | `@` | `v=spf1 include:sendinblue.com ~all` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:your@email.com` |

### 6. Environment Variables
See `.env.example` for all options. At minimum:
- `ANTHROPIC_KEY` — required for AI task breakdown
- `COOKIE_SECRET` — auto-generated if not set, but set it for cookie persistence across restarts
- `ADMIN_PASS` — change the default!

## Security Features
- HMAC-SHA256 signed auth cookies
- CSRF protection on all forms
- Rate limiting (auth, claims, event creation)
- Helmet security headers
- bcrypt password hashing
- Sandboxed systemd service
- Body size limits
- Duplicate claim prevention
- CSV formula injection protection
- No stack trace exposure
