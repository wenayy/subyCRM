#!/bin/sh
set -e
mkdir -p /data

# Generate config.yaml from environment variables
cat > /data/config.yaml << YAML
homeserver:
  address: ${HOMESERVER_URL}
  domain: ${MATRIX_DOMAIN}
  software: standard

appservice:
  address: ${TWITTER_BRIDGE_URL}
  hostname: 0.0.0.0
  port: 29327
  id: twitter
  as_token: ${TWITTER_AS_TOKEN}
  hs_token: ${TWITTER_HS_TOKEN}
  bot:
    username: twitterbot
    displayname: Twitter Bridge Bot
    avatar: mxc://maunium.net/HVHcnusJkQcpVcsVGZRELLCo

bridge:
  username_template: "twitter_{{.}}"
  displayname_template: "{{.Name}} (Twitter)"
  command_prefix: "!tw"
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

# Generate registration.yaml — this gets registered with Conduit
cat > /data/registration.yaml << YAML
id: twitter
url: ${TWITTER_BRIDGE_URL}
as_token: ${TWITTER_AS_TOKEN}
hs_token: ${TWITTER_HS_TOKEN}
sender_localpart: twitterbot
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@twitter_.+:${MATRIX_DOMAIN}"
  aliases: []
  rooms: []
YAML

echo "[mautrix-twitter] Config generated. Starting bridge..."
exec /usr/bin/mautrix-twitter -c /data/config.yaml
