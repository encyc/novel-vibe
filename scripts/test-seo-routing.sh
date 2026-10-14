#!/bin/sh
set -eu

CONF=${1:-nginx/templates/novel-vibe.conf.template}

require() {
  if ! grep -Fq "$1" "$CONF"; then
    echo "missing nginx SEO contract: $1" >&2
    exit 1
  fi
}

require 'server_name ${MAIN_DOMAIN};'
require 'server_name ${APP_DOMAIN};'
require 'server_name ${WWW_DOMAIN};'
require 'root /usr/share/nginx/html/landing;'
require 'alias /usr/share/nginx/html/webui/assets/;'
require 'location = /robots.txt'
require 'location = /sitemap.xml'
require 'location ~ "^/[A-Za-z0-9-]{8,128}\.txt$"'
require 'location = /community'
require 'location ~ ^/community/[^/]+$'
require 'location = /download'
require 'try_files /download.html =404;'
require 'add_header X-Robots-Tag "noindex, nofollow" always;'
require 'return 301 https://${MAIN_DOMAIN}$request_uri;'
require 'ssl_certificate ${MAIN_SSL_CERT};'
require 'ssl_certificate ${APP_SSL_CERT};'

app_block=$(sed -n '/# ── App HTTPS server/,/# ── WWW HTTPS redirect/p' "$CONF")
printf '%s\n' "$app_block" | grep -Fq 'location = /community' || {
  echo "missing App community redirect" >&2
  exit 1
}
printf '%s\n' "$app_block" | grep -Fq 'location / {' || {
  echo "missing App SPA fallback" >&2
  exit 1
}

echo "nginx SEO routing contract passed"
