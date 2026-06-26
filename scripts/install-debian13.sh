#!/usr/bin/env bash
# install-debian13.sh — stand up Travel Companion on a fresh Debian 13 (trixie) box.
#
# Prepares a bare server (Apache, and optionally Certbot + Postfix), then hands
# the application install to deploy.sh. Re-runnable; safe to run again to update.
#
# Quick start on a new server:
#   sudo apt-get update && sudo apt-get install -y git
#   git clone https://github.com/hamBank/travelCompantion.git
#   sudo travelCompantion/scripts/install-debian13.sh --domain trips.example.com \
#        --admin-email you@example.com --with-https --with-mail
#
# Then edit /opt/travelcomp/.env (GOOGLE_CLIENT_ID, ALLOWED_EMAIL) and:
#   sudo systemctl start travelcomp
#
# Flags:
#   --domain <fqdn>        Public hostname for the site            (required)
#   --admin-email <addr>   Email for Let's Encrypt registration    (with --with-https)
#   --with-https           Obtain a certificate with certbot --apache
#   --with-mail            Install & wire Postfix for email ingestion
#   --mail-domain <fqdn>   Domain for import+<token>@…              (default: --domain)
#   --repo <url>           Git repo to deploy        (default: hamBank/travelCompantion)
#   --branch <name>        Branch to deploy                         (default: main)
#   --app-dir <path>       Install location                        (default: /opt/travelcomp)
#   --app-user <name>      Service user                            (default: travelcomp)
#   --port <n>             uvicorn bind port                       (default: 8000)
#   --force                Skip the Debian 13 version check

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────────
DOMAIN=""
ADMIN_EMAIL=""
WITH_HTTPS=false
WITH_MAIL=false
MAIL_DOMAIN=""
REPO_URL="https://github.com/hamBank/travelCompantion.git"
REPO_BRANCH="main"
APP_DIR="/opt/travelcomp"
APP_USER="travelcomp"
SERVICE_NAME="travelcomp"
BIND_PORT="8000"
FORCE=false

info() { echo -e "\033[1;34m▶\033[0m $*"; }
ok()   { echo -e "\033[1;32m✓\033[0m $*"; }
warn() { echo -e "\033[1;33m⚠\033[0m $*"; }
die()  { echo -e "\033[1;31m✗\033[0m $*" >&2; exit 1; }

# ── Parse args ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="$2"; shift 2 ;;
    --admin-email)  ADMIN_EMAIL="$2"; shift 2 ;;
    --with-https)   WITH_HTTPS=true; shift ;;
    --with-mail)    WITH_MAIL=true; shift ;;
    --mail-domain)  MAIL_DOMAIN="$2"; shift 2 ;;
    --repo)         REPO_URL="$2"; shift 2 ;;
    --branch)       REPO_BRANCH="$2"; shift 2 ;;
    --app-dir)      APP_DIR="$2"; shift 2 ;;
    --app-user)     APP_USER="$2"; shift 2 ;;
    --port)         BIND_PORT="$2"; shift 2 ;;
    --force)        FORCE=true; shift ;;
    -h|--help)      sed -n '2,40p' "$0"; exit 0 ;;
    *)              die "Unknown argument: $1 (try --help)" ;;
  esac
done

[[ $EUID -ne 0 ]] && die "Run as root: sudo $0 …"
[[ -z "$DOMAIN" ]] && die "--domain is required"
$WITH_HTTPS && [[ -z "$ADMIN_EMAIL" ]] && die "--with-https requires --admin-email"
MAIL_DOMAIN="${MAIL_DOMAIN:-$DOMAIN}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$REPO_ROOT/deploy.sh" ]] || die "deploy.sh not found next to this script ($REPO_ROOT)"

# ── OS check ────────────────────────────────────────────────────────────────────
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != "debian" || "${VERSION_ID%%.*}" != "13" ]]; then
    msg="This installer targets Debian 13 (trixie); detected ${PRETTY_NAME:-unknown}."
    $FORCE && warn "$msg (continuing: --force)" || die "$msg  Use --force to override."
  fi
fi

echo "═══════════════════════════════════════════════════════"
echo "  Travel Companion — Debian 13 install"
echo "  domain=$DOMAIN  app=$APP_DIR  https=$WITH_HTTPS  mail=$WITH_MAIL"
echo "═══════════════════════════════════════════════════════"

export DEBIAN_FRONTEND=noninteractive

# ── 1. Base OS prerequisites ────────────────────────────────────────────────────
# Debian 13 (trixie) ships Node.js 20 + npm in its own repos, so install them here
# (npm is a separate package on Debian). deploy.sh then sees Node >= 20 and skips
# its NodeSource path, which doesn't reliably target trixie yet.
info "Updating apt and installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl apache2 tzdata nodejs npm
command -v npm >/dev/null || die "npm still not found after install — check: apt-get install npm"
ok "Base packages installed (apache=$(apache2 -v | head -1 | awk '{print $3}')  node=$(node -v)  npm=$(npm -v))"

if $WITH_HTTPS; then
  info "Installing Certbot (Apache plugin)"
  apt-get install -y -qq certbot python3-certbot-apache
  ok "Certbot installed"
fi

if $WITH_MAIL; then
  info "Installing Postfix (non-interactive)"
  debconf-set-selections <<< "postfix postfix/main_mailer_type select Internet Site"
  debconf-set-selections <<< "postfix postfix/mailname string $(hostname -f 2>/dev/null || hostname)"
  apt-get install -y -qq postfix
  ok "Postfix installed"
fi

# ── 2. Apache: modules + vhost (done here, before deploy.sh, so it's always visible) ──
# deploy.sh also writes the vhost on updates; doing it here first means a fresh install
# has a working Apache even if the app build takes a while or later steps need reloading.

VHOST_CONF="/etc/apache2/sites-available/${DOMAIN}.conf"

info "Enabling Apache proxy/header modules"
a2enmod proxy proxy_http headers rewrite
ok "Apache modules enabled"

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

# Enable the app site; disable Debian's catch-all default (dedicated box only).
a2ensite  "$(basename "$VHOST_CONF")"
a2dissite 000-default 2>/dev/null || true   # may already be absent — not an error

if apache2ctl configtest 2>&1; then
  systemctl reload apache2
  ok "Apache configured: $(ls /etc/apache2/sites-enabled/ | tr '\n' ' ')"
else
  # configtest prints its own error; leave Apache running on old config
  warn "apache2ctl configtest failed — fix the config then: sudo systemctl reload apache2"
fi

# ── 3. Application install (delegated to deploy.sh) ─────────────────────────────
# Pass the vhost conf path so deploy.sh doesn't overwrite it with a conflicting path.
info "Running application deploy (deploy.sh)"
DOMAIN="$DOMAIN" REPO_URL="$REPO_URL" REPO_BRANCH="$REPO_BRANCH" \
APP_DIR="$APP_DIR" APP_USER="$APP_USER" SERVICE_NAME="$SERVICE_NAME" \
BIND_PORT="$BIND_PORT" VHOST_CONF="$VHOST_CONF" \
  bash "$REPO_ROOT/deploy.sh"
ok "Application installed at $APP_DIR"

ENV_FILE="$APP_DIR/.env"

# ── 3. HTTPS (optional) ─────────────────────────────────────────────────────────
if $WITH_HTTPS; then
  info "Requesting Let's Encrypt certificate for $DOMAIN"
  if certbot --apache -d "$DOMAIN" -d "www.$DOMAIN" \
       --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect; then
    ok "HTTPS enabled (auto-renewal via certbot.timer)"
  else
    warn "certbot failed — ensure DNS for $DOMAIN points here and port 80 is open, then re-run:"
    warn "    sudo certbot --apache -d $DOMAIN"
  fi
fi

# ── 4. Email ingestion (optional) ───────────────────────────────────────────────
if $WITH_MAIL; then
  info "Configuring Postfix → /ingest/email pipe"

  # Secrets into .env (only if not already set)
  if ! grep -q '^MAIL_INGEST_SECRET=' "$ENV_FILE" 2>/dev/null; then
    echo "MAIL_INGEST_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE"
  fi
  if ! grep -q '^MAIL_DOMAIN=' "$ENV_FILE" 2>/dev/null; then
    echo "MAIL_DOMAIN=$MAIL_DOMAIN" >> "$ENV_FILE"
  fi
  chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"

  chmod +x "$APP_DIR/scripts/mail_ingest_wrapper.sh" "$APP_DIR/mail_ingest.py"

  # main.cf
  postconf -e "recipient_delimiter = +"
  postconf -e "inet_interfaces = all"
  postconf -e "inet_protocols = ipv4"
  postconf -e "transport_maps = hash:/etc/postfix/transport"
  postconf -e "mydestination = \$myhostname, localhost.\$mydomain, localhost, $MAIL_DOMAIN"
  postconf -e "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination"

  # transport map
  echo "import@$MAIL_DOMAIN    travelcomp:" > /etc/postfix/transport
  postmap /etc/postfix/transport

  # master.cf pipe service (idempotent)
  if ! grep -q '^travelcomp ' /etc/postfix/master.cf; then
    cat >> /etc/postfix/master.cf <<MCF
travelcomp unix  -       n       n       -       -       pipe
  flags=Rq user=$APP_USER argv=$APP_DIR/scripts/mail_ingest_wrapper.sh \${recipient}
MCF
  fi

  if postfix check; then
    systemctl restart postfix
    systemctl restart "$SERVICE_NAME" 2>/dev/null || true
    ok "Postfix configured for import+<token>@$MAIL_DOMAIN"
    warn "Add an MX record:  $MAIL_DOMAIN.  MX 10 $(hostname -f 2>/dev/null || hostname)."
    warn "Ensure inbound TCP port 25 is open at your cloud firewall."
  else
    warn "postfix check failed — review /etc/postfix/main.cf and master.cf"
  fi
fi

# ── 5. Summary ──────────────────────────────────────────────────────────────────
echo ""
ok "Install complete."
echo ""
echo "  Next steps:"
echo "    1. Add required secrets:   sudo nano $ENV_FILE"
echo "         GOOGLE_CLIENT_ID, ALLOWED_EMAIL   (auth)"
$WITH_MAIL && echo "         MAIL_INGEST_SECRET / MAIL_DOMAIN were generated for you"
echo "    2. Start the service:      sudo systemctl start ${SERVICE_NAME}"
echo "    3. Tail logs:              sudo journalctl -u ${SERVICE_NAME} -f"
echo "    4. Point DNS A record for $DOMAIN at this server"
$WITH_MAIL && echo "    5. Email setup details:    $APP_DIR/docs/email-ingestion.md"
echo ""
