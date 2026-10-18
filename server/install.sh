#!/usr/bin/env bash
# One-command setup for the Jackbox bot on a fresh Ubuntu VPS (24.04 or newer).
#
#   curl -fsSL https://raw.githubusercontent.com/zigzageer/jackboxy/main/server/install.sh | sudo bash
#
# Installs Wine, a virtual screen (Xvfb + openbox), a virtual sound card
# (PulseAudio null sink), ffmpeg, MediaMTX for the WebRTC stream, Node.js and
# the bot, all as systemd services running as the "jackbox" user. Safe to re-run
# to update. Afterwards run `sudo jackbox-config` to enter the Discord token.
set -euo pipefail

REPO_URL=${JACKBOX_REPO:-https://github.com/zigzageer/jackboxy.git}
BRANCH=${JACKBOX_BRANCH:-main}
MEDIAMTX_VERSION=${MEDIAMTX_VERSION:-v1.15.0}
APP_USER=jackbox
APP_DIR=/opt/jackbox
REPO_DIR=$APP_DIR/repo
BOT_DIR=$REPO_DIR/bot
GAMES_DIR=$APP_DIR/games
DISPLAY_NUM=:99
SCREEN_SIZE=1280x720

log() { printf '\n==> %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then echo "Run this with sudo." >&2; exit 1; fi
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then echo "Warning: written for Ubuntu 24.04, found ${PRETTY_NAME:-unknown}." >&2; fi
export DEBIAN_FRONTEND=noninteractive

log "Installing system packages"
dpkg --add-architecture i386
apt-get update -q
apt-get install -y -q ca-certificates curl git xvfb openbox xdotool pulseaudio ffmpeg \
  tesseract-ocr fonts-dejavu-core wine wine64 wine32:i386 winbind
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [[ $(node_major) -lt 22 ]]; then
  log "Installing Node.js 22"
  # Newer Ubuntu releases ship Node 22+ themselves; older ones need NodeSource.
  apt-get install -y -q nodejs npm || true
  if [[ $(node_major) -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -q nodejs
  fi
fi
# Ubuntu's own nodejs package leaves npm out (NodeSource's includes it).
command -v npm >/dev/null || apt-get install -y -q npm

log "Creating the $APP_USER user and folders"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir $APP_DIR/home --shell /usr/sbin/nologin $APP_USER
mkdir -p $APP_DIR $GAMES_DIR
chown $APP_USER:$APP_USER $APP_DIR $GAMES_DIR
# Shared runtime dir so the game, ffmpeg and PulseAudio find the same audio socket.
echo "d /run/jackbox 0700 $APP_USER $APP_USER -" > /etc/tmpfiles.d/jackbox.conf
systemd-tmpfiles --create /etc/tmpfiles.d/jackbox.conf

log "Fetching the bot ($BRANCH)"
if [[ -d $REPO_DIR/.git ]]; then
  sudo -u $APP_USER git -C $REPO_DIR remote set-url origin "$REPO_URL"
  sudo -u $APP_USER git -C $REPO_DIR fetch -q origin "$BRANCH"
  sudo -u $APP_USER git -C $REPO_DIR checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  sudo -u $APP_USER git clone -q --branch "$BRANCH" --single-branch "$REPO_URL" $REPO_DIR
fi
sudo -u $APP_USER bash -c "cd $BOT_DIR && npm ci --omit=dev --no-audit --no-fund"
[[ -f $BOT_DIR/games.json ]] || sudo -u $APP_USER cp $REPO_DIR/server/games.linux.json $BOT_DIR/games.json
install -m 0755 $REPO_DIR/server/jackbox-config /usr/local/bin/jackbox-config
install -m 0755 $REPO_DIR/server/jackbox-steam /usr/local/bin/jackbox-steam

log "Installing MediaMTX $MEDIAMTX_VERSION"
if ! /usr/local/bin/mediamtx --version 2>/dev/null | grep -q "$MEDIAMTX_VERSION"; then
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX_VERSION/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz" | tar -xz -C "$tmp" mediamtx
  install -m 0755 "$tmp/mediamtx" /usr/local/bin/mediamtx
  rm -rf "$tmp"
fi
# Small servers (2 cores) share the CPU between the game and the encoder, so stream fewer frames.
if [[ $(nproc) -le 2 ]]; then STREAM_FPS=24; STREAM_BITRATE=1800k; else STREAM_FPS=30; STREAM_BITRATE=2500k; fi
PUBLIC_IP=${PUBLIC_IP:-$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')}
sed "s/PUBLIC_IP/$PUBLIC_IP/" $REPO_DIR/server/mediamtx.yml > /etc/jackbox-mediamtx.yml

log "Setting up the virtual sound card"
install -d -o $APP_USER -g $APP_USER $APP_DIR/home/.config/pulse
cat > $APP_DIR/home/.config/pulse/default.pa <<'EOF'
.include /etc/pulse/default.pa
load-module module-null-sink sink_name=game sink_properties=device.description=game
set-default-sink game
EOF
chown $APP_USER:$APP_USER $APP_DIR/home/.config/pulse/default.pa

log "Preparing Wine (first run takes a minute)"
sudo -u $APP_USER env HOME=$APP_DIR/home WINEPREFIX=$APP_DIR/wine WINEDEBUG=-all DISPLAY= wineboot --init >/dev/null 2>&1 || true

log "Writing systemd services"
common_env="Environment=HOME=$APP_DIR/home
Environment=DISPLAY=$DISPLAY_NUM
Environment=XDG_RUNTIME_DIR=/run/jackbox
Environment=WINEPREFIX=$APP_DIR/wine
Environment=WINEDEBUG=-all"

cat > /etc/systemd/system/jackbox-screen.service <<EOF
[Unit]
Description=Jackbox virtual screen
[Service]
User=$APP_USER
ExecStart=/usr/bin/Xvfb $DISPLAY_NUM -screen 0 ${SCREEN_SIZE}x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/jackbox-wm.service <<EOF
[Unit]
Description=Jackbox window manager
Requires=jackbox-screen.service
After=jackbox-screen.service
[Service]
User=$APP_USER
$common_env
ExecStartPre=/bin/sleep 1
ExecStart=/usr/bin/openbox
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/jackbox-audio.service <<EOF
[Unit]
Description=Jackbox virtual sound card
[Service]
User=$APP_USER
$common_env
ExecStart=/usr/bin/pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/jackbox-stream.service <<EOF
[Unit]
Description=Jackbox WebRTC stream server (MediaMTX)
After=network-online.target
[Service]
User=$APP_USER
ExecStart=/usr/local/bin/mediamtx /etc/jackbox-mediamtx.yml
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/jackbox-bot.service <<EOF
[Unit]
Description=Jackbox Discord bot
Requires=jackbox-screen.service jackbox-audio.service jackbox-stream.service
After=jackbox-wm.service jackbox-audio.service jackbox-stream.service network-online.target
[Service]
User=$APP_USER
$common_env
Environment=STREAM_PUBLIC_URL=http://$PUBLIC_IP:8889/game
Environment=STREAM_SIZE=$SCREEN_SIZE
Environment=STREAM_FPS=$STREAM_FPS
Environment=STREAM_BITRATE=$STREAM_BITRATE
WorkingDirectory=$BOT_DIR
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now jackbox-screen jackbox-wm jackbox-audio jackbox-stream
if [[ -f $BOT_DIR/.env ]]; then
  systemctl enable jackbox-bot
  systemctl restart jackbox-bot
fi

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  log "Opening stream ports in the firewall"
  ufw allow 8889/tcp
  ufw allow 8189/udp
fi

cat <<EOF

Done. Next steps:
  1. Run:  sudo jackbox-steam
     to download your Jackbox packs from your Steam account.
  2. Run:  sudo jackbox-config
     to enter your Discord bot token and start the bot.
  The stream will be at http://$PUBLIC_IP:8889/game while a game runs.
EOF
