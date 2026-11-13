#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
node_major=$($node_bin -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi

label='dev.codex.remote'
if [ -n "${CODEX_REMOTE_LAUNCH_LABEL:-}" ]; then
  label=$CODEX_REMOTE_LAUNCH_LABEL
fi
agent_dir="$HOME/Library/LaunchAgents"
state_dir="$HOME/.local/state/codex-remote"
plist="$agent_dir/$label.plist"
mkdir -p "$agent_dir" "$state_dir"
chmod 700 "$state_dir"

if [ -e "$plist" ]; then
  echo "LaunchAgent already exists: $plist" >&2
  echo 'Inspect and remove it before reinstalling.' >&2
  exit 1
fi

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}
label_xml=$(escape_xml "$label")
node_xml=$(escape_xml "$node_bin")
server_xml=$(escape_xml "$repo_dir/server.mjs")
out_xml=$(escape_xml "$state_dir/server.out.log")
err_xml=$(escape_xml "$state_dir/server.err.log")

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label_xml</string>
  <key>ProgramArguments</key><array><string>$node_xml</string><string>$server_xml</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$out_xml</string>
  <key>StandardErrorPath</key><string>$err_xml</string>
</dict></plist>
EOF
chmod 600 "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed and started $label"
echo 'Enable a chat with: node control.mjs enable'
