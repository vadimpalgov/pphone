#!/bin/sh
set -e

mkdir -p /etc/asterisk/keys
if [ ! -f /etc/asterisk/keys/asterisk.pem ]; then
  openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -subj "/CN=pphone.home" \
    -keyout /tmp/key.pem -out /tmp/cert.pem 2>/dev/null
  cat /tmp/cert.pem /tmp/key.pem > /etc/asterisk/keys/asterisk.pem
  rm -f /tmp/key.pem /tmp/cert.pem
fi

exec asterisk -f -vvv
