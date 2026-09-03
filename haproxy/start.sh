#!/bin/sh
set -e
mkdir -p /run/haproxy /etc/haproxy/maps /etc/haproxy/ssl /etc/haproxy/general \
  /etc/haproxy/spoe /var/lib/dataplaneapi/transactions /var/lib/dataplaneapi/backups
haproxy -W -D -S /run/haproxy/master.sock -p /run/haproxy/haproxy.pid -f /etc/haproxy/haproxy.cfg
sleep 2
exec dataplaneapi -m /run/haproxy/master.sock -f /etc/haproxy/dataplaneapi.yml
