#!/bin/sh
set -e

EXTERNAL_IP="${EXTERNAL_IP:-161.104.44.145}"

# IP контейнера в docker-сетях не гарантированно одинаковый между
# пересозданиями - генерируем маппинг ICE host-кандидатов (см. rtp.conf)
# заново при каждом старте, а не храним статично в конфиге.
{
  echo "[ice_host_candidates]"
  ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | while read -r ip; do
    echo "$ip => $EXTERNAL_IP"
  done
} > /etc/asterisk/ice_host_candidates.conf

mkdir -p /etc/asterisk/keys
if [ ! -f /etc/asterisk/keys/asterisk.pem ]; then
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -subj "/CN=pphone.home" \
    -keyout /tmp/key.pem -out /tmp/cert.pem 2>/dev/null
  cat /tmp/cert.pem /tmp/key.pem > /etc/asterisk/keys/asterisk.pem
  rm -f /tmp/key.pem /tmp/cert.pem
fi

exec asterisk -f -vvv
