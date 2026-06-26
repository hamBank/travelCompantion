#!/usr/bin/env bash
# deploy.sh — install or update Travel Companion on a Debian/Ubuntu server
#
# Usage:
#   First deploy:  sudo ./deploy.sh
#   Update only:   sudo ./deploy.sh --update
#
# What it does:
#   - Installs system packages (Python 3, Node.js 20)
#   - Creates a dedicated 'travelcomp' system user and /opt/travelcomp
#   - Clones (or pulls) the repo, builds the frontend, installs Python deps
#   - Writes a .env file the first time (you fill in secrets afterwards)
#   - Creates and enables a systemd service (uvicorn on 127.0.0.1:8000)
#   - Installs the Apache VirtualHost and enables required modules
#
# Re-running is safe — all steps are idempotent.

set -euo pipefail

# ── Config (override via environment for a new server) ──────────────────────────
APP_USER="${APP_USER:-travelcomp}"
APP_DIR="${APP_DIR:-/opt/travelcomp}"
REPO_URL="${REPO_URL:-https://github.com/hamBank/travelCompantion.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-travelcomp}"
DOMAIN="${DOMAIN:-tripplan.hups.club}"
VHOST_CONF="${VHOST_CONF:-/etc/apache2/sites-available/${DOMAIN}.conf}"
BIND_PORT="${BIND_PORT:-8000}"
# ──────────────────────────────────────────────────────────────────────────────

UPDATE_ONLY=false
[[ "${1:-}" == "--update" ]] && UPDATE_ONLY=true

echo "═══════════════════════════════════════════════════════"
echo "  Deploy triggered: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "═══════════════════════════════════════════════════════"

# Remember if the service was already running before we touch anything
_WAS_RUNNING=false
systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null && _WAS_RUNNING=true

# When triggered by the path watcher, remove the trigger file immediately.
# ExecStartPost only runs on success, so if we leave it to ExecStartPost and
# the deploy fails, the file stays and the watcher re-fires → infinite loop.
if $UPDATE_ONLY; then
  rm -f "$APP_DIR/.deploy-trigger" 2>/dev/null || true
fi

# ── Helpers ────────────────────────────────────────────────────────────────────
info()  { echo -e "\033[1;34m▶\033[0m $*"; }
ok()    { echo -e "\033[1;32m✓\033[0m $*"; }
warn()  { echo -e "\033[1;33m⚠\033[0m $*"; }
die()   { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root: sudo $0 $*"
command -v apache2 &>/dev/null || die "apache2 not found — is it installed?"

# ── 1. System packages ─────────────────────────────────────────────────────────
if ! $UPDATE_ONLY; then
  info "Installing system packages"
  apt-get update -qq

  # Python
  apt-get install -y -qq python3 python3-pip python3-venv

  # Node.js 20 (via NodeSource) — skip if already at v20+
  if ! command -v node &>/dev/null; then
    info "Installing Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
  else
    NODE_MAJOR=$(node -e "process.stdout.write(String(parseInt(process.version.slice(1))))")
    if [[ "$NODE_MAJOR" -lt 20 ]]; then
      info "Upgrading Node.js to v20"
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
      apt-get install -y -qq nodejs
    fi
  fi

  # npm is bundled with NodeSource's nodejs but is a SEPARATE package in the
  # Debian repos — install it explicitly if it's not already on PATH.
  command -v npm &>/dev/null || apt-get install -y -qq npm

  # git (Apache already present)
  apt-get install -y -qq git

  ok "System packages ready  python=$(python3 --version | cut -d' ' -f2)  node=$(node -v)  npm=$(npm -v)"

  # ── Apache modules ─────────────────────────────────────────────────────────
  info "Enabling Apache modules (proxy, headers)"
  a2enmod proxy proxy_http headers rewrite
  ok "Apache modules enabled"
fi

# ── 2. App user & directory ────────────────────────────────────────────────────
if ! $UPDATE_ONLY; then
  if ! id "$APP_USER" &>/dev/null; then
    info "Creating system user '$APP_USER'"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  fi

  mkdir -p "$APP_DIR"
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
# Ensure pipe scripts are executable (git clone preserves mode bits, but an
# explicit chmod guards against any umask or fs-mount edge cases).
chmod +x "$APP_DIR/mail_ingest.py" "$APP_DIR/scripts/mail_ingest_wrapper.sh" 2>/dev/null || true

# ── 4. Python virtualenv + dependencies ───────────────────────────────────────
VENV="$APP_DIR/.venv"
if [[ ! -d "$VENV" ]]; then
  info "Creating Python virtualenv"
  sudo -u "$APP_USER" python3 -m venv "$VENV"
fi

info "Installing Python dependencies"
PIP_CACHE="$APP_DIR/.pip-cache"
mkdir -p "$PIP_CACHE" && chown "$APP_USER:$APP_USER" "$PIP_CACHE"
sudo -u "$APP_USER" env PIP_CACHE_DIR="$PIP_CACHE" "$VENV/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" env PIP_CACHE_DIR="$PIP_CACHE" "$VENV/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
ok "Python dependencies installed"

# ── 5. Systemd service + deploy watcher ────────────────────────────────────────
# Done BEFORE the npm build so the units always exist even if the build fails.
# The service file only references filesystem paths (VENV, APP_DIR, ENV_FILE)
# which are already set; systemd doesn't validate them at enable time.
ENV_FILE="$APP_DIR/.env"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
info "Writing systemd service → $SERVICE_FILE"
cat > "$SERVICE_FILE" <<SVCEOF
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
SVCEOF

cat > "/etc/systemd/system/${SERVICE_NAME}-update.service" <<USVC
[Unit]
Description=Travel Companion auto-update (triggered by webhook)

[Service]
Type=oneshot
User=root
# No timeout — npm install on a cold cache can take several minutes.
TimeoutStartSec=0
ExecStart=/bin/bash $APP_DIR/deploy.sh --update
ExecStartPost=/bin/rm -f $APP_DIR/.deploy-trigger
StandardOutput=append:/var/log/travelcomp-deploy.log
StandardError=append:/var/log/travelcomp-deploy.log
USVC

cat > "/etc/systemd/system/${SERVICE_NAME}-update.path" <<UPATH
[Unit]
Description=Watch for Travel Companion deploy trigger file

[Path]
PathExists=$APP_DIR/.deploy-trigger
Unit=${SERVICE_NAME}-update.service

[Install]
WantedBy=multi-user.target
UPATH

# Only enable/start on first install. On updates the units are already active,
# and calling systemctl from within the running update service itself causes
# a circular dependency → systemd returns exit code 243/CREDENTIALS.
if ! $UPDATE_ONLY; then
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl enable --now "${SERVICE_NAME}-update.path"
  ok "Systemd units created and enabled: ${SERVICE_FILE}"
else
  # Never call daemon-reload or enable from within the running update service.
  # On Debian 13 (systemd 257+) daemon-reload re-evaluates the *running* unit
  # mid-flight and returns 243/CREDENTIALS, causing the service to fail and
  # the path watcher to immediately re-trigger (infinite loop).
  # Unit file definition changes land on the next fresh install or manual:
  #   sudo systemctl daemon-reload
  ok "Systemd unit definitions written (daemon-reload skipped inside update service)"
fi

# ── 6b. Frontend build ──────────────────────────────────────────────────────────
# HOME=$APP_DIR prevents npm writing to /nonexistent when the service user has no home dir.
NPM="sudo -u $APP_USER HOME=$APP_DIR npm"
# Ensure the npm cache dir is owned by the service user (root can write it
# on first install, leaving files that block subsequent travelcomp-owned runs).
chown -R "$APP_USER:$APP_USER" "$APP_DIR/.npm" 2>/dev/null || true

info "Installing Node dependencies"
$NPM --prefix "$APP_DIR/frontend" ci --silent

info "Building frontend"
$NPM --prefix "$APP_DIR/frontend" run build
ok "Frontend built → backend/static"

# ── 6c. Coverage reports → /coverage (best-effort; never abort the deploy) ──────
# Generated AFTER the build, since the build empties backend/static.
info "Generating coverage reports"
COV_DIR="$APP_DIR/backend/static/coverage"
sudo -u "$APP_USER" mkdir -p "$COV_DIR"
sudo -u "$APP_USER" sh -c "cd '$APP_DIR' && '$VENV/bin/python' -m pytest --cov=backend --cov-report=html:backend/static/coverage/backend -q" \
  || warn "backend coverage generation failed (continuing)"
$NPM --prefix "$APP_DIR/frontend" run coverage \
  || warn "frontend coverage generation failed (continuing)"
tee "$COV_DIR/index.html" >/dev/null <<HTML
<!doctype html><meta charset="utf-8"><title>Coverage</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6}a{color:#1e66f5}</style>
<h1>Test coverage</h1>
<p>Generated $(date '+%Y-%m-%d %H:%M %Z') · build $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)</p>
<ul>
  <li><a href="./backend/index.html">Backend (pytest)</a></li>
  <li><a href="./frontend/index.html">Frontend (vitest)</a></li>
</ul>
HTML
ok "Coverage reports → /coverage"

# ── 7. Environment file ────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating $ENV_FILE (fill in secrets before starting)"
  cat > "$ENV_FILE" <<ENVEOF
# Google OAuth (required for authentication)
GOOGLE_CLIENT_ID=
ALLOWED_EMAIL=
JWT_SECRET=$(openssl rand -hex 32)

# Google Sheets (required for sheet import)
SPREADSHEET_ID=
SHEET_NAMES=

# Optional: Google Places API for accommodation/restaurant/activity enrichment
# GOOGLE_PLACES_API_KEY=

# Optional: AeroDataBox via RapidAPI — flight live-check
# AERODATABOX_KEY=

# Optional: GitHub webhook auto-deploy secret (set same value in GitHub webhook settings)
# DEPLOY_SECRET=

# Optional: email ingestion (forward bookings to import+<token>@MAIL_DOMAIN)
# MAIL_INGEST_SECRET=$(openssl rand -hex 32)
# MAIL_DOMAIN=tripplan.hups.club

# JWT session lifetime in days (default 30)
# JWT_EXPIRE_DAYS=30
ENVEOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  warn "Edit $ENV_FILE and add your secrets before starting the service"
else
  ok ".env already exists — not overwritten"
fi

# ── 8. Apache VirtualHost ──────────────────────────────────────────────────────
info "Writing Apache VirtualHost → $VHOST_CONF"
cat > "$VHOST_CONF" <<VHEOF
<VirtualHost *:80>
    ServerName ${DOMAIN}
    ServerAlias www.${DOMAIN}

    ErrorLog  \${APACHE_LOG_DIR}/travelcomp_error.log
    CustomLog \${APACHE_LOG_DIR}/travelcomp_access.log combined

    # Security headers
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "DENY"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"

    # Proxy everything to uvicorn
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:${BIND_PORT}/
    ProxyPassReverse / http://127.0.0.1:${BIND_PORT}/

    # Forward real client IP to FastAPI
    RequestHeader set X-Forwarded-Proto "http"
    RequestHeader set X-Real-IP "%{REMOTE_ADDR}s"

    # Aggressive caching for Vite content-hashed assets
    <LocationMatch "^/assets/">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </LocationMatch>
</VirtualHost>
VHEOF

a2ensite "$(basename "$VHOST_CONF")" 2>/dev/null || true
if /usr/sbin/apache2ctl configtest 2>/dev/null; then
  systemctl reload apache2 || true
  ok "Apache VirtualHost enabled and reloaded: $(ls /etc/apache2/sites-enabled/ | tr '\n' ' ')"
else
  warn "Apache config test failed (broken cert?) — check: sudo apache2ctl configtest"
fi

# ── 9. (Re)start service ──────────────────────────────────────────────────────
if $UPDATE_ONLY || $_WAS_RUNNING; then
  info "Restarting $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 2
  systemctl is-active --quiet "$SERVICE_NAME" \
    && ok "Service running" \
    || warn "Service failed — check: journalctl -u $SERVICE_NAME -n 40"
else
  warn "First deploy complete. Next steps:"
  echo ""
  echo "  1. Fill in secrets:    sudo nano $ENV_FILE"
  echo "  2. Start the service:  sudo systemctl start $SERVICE_NAME"
  echo "  3. Tail logs:          sudo journalctl -u $SERVICE_NAME -f"
  echo ""
  echo "  Optional — enable HTTPS with Let's Encrypt:"
  echo "    sudo apt install certbot python3-certbot-apache"
  echo "    sudo certbot --apache -d $DOMAIN"
fi

ok "Done"
