#!/bin/sh
set -e
mkdir -p /run/haproxy /etc/haproxy/maps /etc/haproxy/ssl /etc/haproxy/general \
  /etc/haproxy/spoe /var/lib/dataplaneapi/transactions /var/lib/dataplaneapi/backups
haproxy -W -D -S /run/haproxy/master.sock -p /run/haproxy/haproxy.pid -f /etc/haproxy/haproxy.cfg
sleep 2
# dataplaneapi execs the reload command WITHOUT a shell (plain argv
# split), so any $(...) or quoting in reload_cmd breaks. The logic lives
# in /reload.sh instead (see haproxy/reload.sh).
exec dataplaneapi -m /run/haproxy/master.sock -f /etc/haproxy/dataplaneapi.yml \
  --reload-cmd /reload.sh
