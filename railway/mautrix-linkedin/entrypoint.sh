#!/bin/sh
set -e
mkdir -p /data

cat > /data/config.yaml << YAML
homeserver:
  address: ${HOMESERVER_URL}
  domain: ${MATRIX_DOMAIN}
  software: standard

appservice:
  address: ${LINKEDIN_BRIDGE_URL}
  hostname: 0.0.0.0
  port: 29328
  id: linkedin
  as_token: ${LINKEDIN_AS_TOKEN}
  hs_token: ${LINKEDIN_HS_TOKEN}
  bot:
    username: linkedinbot
    displayname: LinkedIn Bridge Bot

bridge:
  username_template: "linkedin_{{.}}"
  displayname_template: "{{.Name}} (LinkedIn)"
  command_prefix: "!li"
  initial_chat_sync: 50
  sync_direct_chat_list: true
  permissions:
    "*": relay
    "@admin:${MATRIX_DOMAIN}": admin

database:
  type: postgres
  uri: ${DATABASE_URL}

logging:
  min_level: warn
  writers:
    - type: stdout
      format: text
      color: false
YAML

cat > /data/registration.yaml << YAML
id: linkedin
url: ${LINKEDIN_BRIDGE_URL}
as_token: ${LINKEDIN_AS_TOKEN}
hs_token: ${LINKEDIN_HS_TOKEN}
sender_localpart: linkedinbot
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@linkedin_.+:${MATRIX_DOMAIN}"
  aliases: []
  rooms: []
YAML

echo "[mautrix-linkedin] Config generated. Starting bridge..."
exec /usr/bin/mautrix-linkedin -c /data/config.yaml
