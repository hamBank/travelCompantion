#!/usr/bin/env bash
# deploy.sh — install or update Travel Companion on a Debian/Ubuntu server
#
# Usage:
#   First deploy:  sudo ./deploy.sh
#   Update only:   sudo ./deploy.sh --update
#
# What it does:
#   - Installs system packages (Python 3, Node.js 20, nginx)
#   - Creates a dedicated 'travelcomp' system user and /opt/travelcomp
#   - Clones (or pulls) the repo, builds the frontend, installs Python deps
#   - Writes a .env file the first time (you fill in secrets afterwards)
#   - Creates and enables a systemd service (uvicorn on 127.0.0.1:8000)
#   - Configures nginx to reverse-proxy port 80 → uvicorn
#
# Re-running is safe — all steps are idempotent.

set -euo pipefail

# ── Config — edit these ────────────────────────────────────────────────────────
APP_USER="travelcomp"
APP_DIR="/opt/travelcomp"
REPO_URL="https://github.com/hamBank/travelCompantion.git"
REPO_BRANCH="claude/elegant-hopper-x82z32"
SERVICE_NAME="travelcomp"
NGINX_HOST="_"          # set to your domain, e.g. travel.example.com
BIND_PORT="8000"
# ──────────────────────────────────────────────────────────────────────────────

UPDATE_ONLY=false
[[ "${1:-}" == "--update" ]] && UPDATE_ONLY=true

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m▶\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
warn()  { echo -e "\033[1;33m⚠\033[0m $*"; }
die()   { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root: sudo $0 $*"

# ── 1. System packages ─────────────────────────────────────────────────────────
if ! $UPDATE_ONLY; then
  info "Installing system packages"
  apt-get update -qq

  # Python
  apt-get install -y -qq python3 python3-pip python3-venv

  # Node.js 20 (via NodeSource)
  if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(parseInt(process.version.slice(1))>=20?0:1)' ; echo $?)" != "0" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
  fi

  # nginx, git
  apt-get install -y -qq nginx git

  ok "System packages ready (python $(python3 --version | cut -d' ' -f2), node $(node -v), nginx)"
fi

# ── 2. App user & directory ────────────────────────────────────────────────────
if ! $UPDATE_ONLY; then
  if ! id "$APP_USER" &>/dev/null; then
    info "Creating system user '$APP_USER'"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi

  if [[ ! -d "$APP_DIR" ]]; then
    info "Creating app directory $APP_DIR"
    mkdir -p "$APP_DIR"
  fi
  chown "$APP_USER:$APP_USER" "$APP_DIR"
fi

# ── 3. Clone or update repo ────────────────────────────────────────────────────
if [[ ! -d "$APP_DIR/.git" ]]; then
  info "Cloning repo → $APP_DIR"
  sudo -u "$APP_USER" git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
else
  info "Pulling latest ($REPO_BRANCH)"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$REPO_BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
fi
ok "Repo up to date"

# ── 4. Python virtualenv + dependencies ───────────────────────────────────────
VENV="$APP_DIR/.venv"
if [[ ! -d "$VENV" ]]; then
  info "Creating Python virtualenv"
  sudo -u "$APP_USER" python3 -m venv "$VENV"
fi

info "Installing Python dependencies"
sudo -u "$APP_USER" "$VENV/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$VENV/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
ok "Python dependencies installed"

# ── 5. Frontend build ──────────────────────────────────────────────────────────
info "Installing Node dependencies"
sudo -u "$APP_USER" npm --prefix "$APP_DIR/frontend" ci --silent

info "Building frontend"
sudo -u "$APP_USER" npm --prefix "$APP_DIR/frontend" run build
ok "Frontend built → backend/static"

# ── 6. Environment file ────────────────────────────────────────────────────────
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating $ENV_FILE (fill in secrets before starting)"
  cat > "$ENV_FILE" <<EOF
# Google OAuth (required for authentication)
# See .env.example for setup instructions
GOOGLE_CLIENT_ID=
ALLOWED_EMAIL=
JWT_SECRET=$(openssl rand -hex 32)

# Google Sheets (required for sheet import)
SPREADSHEET_ID=
SHEET_NAMES=

# Optional: Google Places API for accommodation enrichment
# GOOGLE_PLACES_API_KEY=

# JWT session lifetime in days (default 30)
# JWT_EXPIRE_DAYS=30
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  warn "Edit $ENV_FILE and add your secrets, then: sudo systemctl start $SERVICE_NAME"
else
  ok ".env already exists — not overwritten"
fi

# ── 7. Systemd service ─────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
info "Writing systemd service → $SERVICE_FILE"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Travel Companion API
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$VENV/bin/uvicorn backend.main:app --host 127.0.0.1 --port $BIND_PORT
Restart=always
RestartSec=5

# Harden the service
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
ok "Systemd service enabled"

# ── 8. nginx reverse proxy ─────────────────────────────────────────────────────
NGINX_CONF="/etc/nginx/sites-available/$SERVICE_NAME"
if [[ ! -f "$NGINX_CONF" ]] || ! $UPDATE_ONLY; then
  info "Writing nginx config"
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $NGINX_HOST;

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Proxy all requests to uvicorn
    location / {
        proxy_pass         http://127.0.0.1:$BIND_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;

        # WebSocket support (if needed in future)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
    }

    # Cache static assets aggressively (they are content-hashed by Vite)
    location ~* ^/assets/ {
        proxy_pass http://127.0.0.1:$BIND_PORT;
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
EOF

  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
  # Remove default site if still present
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  ok "nginx configured"
fi

# ── 9. (Re)start service ───────────────────────────────────────────────────────
if $UPDATE_ONLY; then
  info "Restarting $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 2
  systemctl is-active --quiet "$SERVICE_NAME" && ok "Service running" || {
    warn "Service failed to start — check: journalctl -u $SERVICE_NAME -n 40"
  }
else
  # Don't auto-start on first deploy until .env is filled in
  warn "First deploy complete. Next steps:"
  echo "  1. Edit secrets:  nano $ENV_FILE"
  echo "  2. Start service: sudo systemctl start $SERVICE_NAME"
  echo "  3. View logs:     sudo journalctl -u $SERVICE_NAME -f"
  echo ""
  echo "  Optional — enable HTTPS with Let's Encrypt:"
  echo "    sudo apt install certbot python3-certbot-nginx"
  echo "    sudo certbot --nginx -d your-domain.com"
fi

ok "Done"
