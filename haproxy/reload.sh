#!/bin/sh
# Used as dataplaneapi's --reload-cmd. dataplaneapi execs the command
# WITHOUT a shell (plain argv split), so no $(...) or quoting is possible
# here - putting the logic in a script file is the reliable way.
exec haproxy -W -D -S /run/haproxy/master.sock \
  -p /run/haproxy/haproxy.pid \
  -f /etc/haproxy/haproxy.cfg \
  -sf "$(cat /run/haproxy/haproxy.pid)"
