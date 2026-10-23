#!/usr/bin/env bash
# Root part of the rootless Docker install (hardening/05 spike).
# Run once with sudo; it installs packages only, no daemon runs as root.
set -euo pipefail
apt-get update
apt-get install -y ca-certificates curl uidmap dbus-user-session slirp4netns iptables
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce-cli docker-ce docker-ce-rootless-extras
# Stop and disable the rootful daemon the docker-ce package starts.
systemctl disable --now docker.service docker.socket || true
rm -f /var/run/docker.sock
