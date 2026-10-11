#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# System test, run inside an OpenWrt container booted with procd as PID 1
# (tests/boot.sh, with NET_ADMIN for the firewall):
#
#   docker exec <container> sh /work/tests/system.sh
#
# smoke.sh calls the handler and the generators directly. This goes through
# what a router runs instead: rpcd and its ACLs over uhttpd's /ubus, LuCI's
# login and the Treadle view, the tproxy ruleset loaded into the kernel, and
# sing-box started, reloaded and stopped by procd through the same RPCs the
# Status page uses. What still needs a real router is traffic itself:
# packets redirected, DNS answered, a node dialled.

set -u

WORK=/work
OUT=/tmp/system
ACL=/usr/share/rpcd/acl.d/luci-app-treadle.json
NULL_SID=00000000000000000000000000000000

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf 'FAIL %s\n' "$*"; }
die()  { printf 'FATAL %s\n' "$*"; exit 1; }
step() { printf '\n== %s\n' "$*"; }

mkdir -p "$OUT"

# wait_for <seconds> <command…>: true as soon as the command succeeds.
wait_for() {
	n=$1
	shift
	while [ "$n" -gt 0 ]; do
		"$@" && return 0
		sleep 1
		n=$((n - 1))
	done
	return 1
}

# One JSON-RPC call through uhttpd, as LuCI makes it.
rpc() {
	curl -s -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"call\",\"params\":[\"$1\",\"$2\",\"$3\",${4:-{\}}]}" \
		http://127.0.0.1/ubus
}

login() {
	rpc "$NULL_SID" session login "{\"username\":\"$1\",\"password\":\"$2\"}" \
		| sed -n 's/.*"ubus_rpc_session":"\([0-9a-f]*\)".*/\1/p'
}

running() {
	[ "$(ubus call service list '{"name":"treadle"}' 2>/dev/null \
		| jsonfilter -e '@.treadle.instances.singbox.running' 2>/dev/null)" = true ]
}
stopped() { ! running && ! pidof sing-box >/dev/null; }
has_ruleset() { nft list table inet treadle >/dev/null 2>&1; }
no_ruleset() { ! has_ruleset; }

# --- boot ----------------------------------------------------------------------

step "boot"
[ "$(cat /proc/1/comm)" = procd ] \
	|| die "PID 1 is $(cat /proc/1/comm), not procd: start the container with tests/boot.sh"
ok "procd is PID 1"
for o in system service rc; do
	ubus list "$o" >/dev/null 2>&1 && ok "ubus object $o" || bad "no ubus object $o"
done

# --- install -------------------------------------------------------------------

step "install"
# shellcheck source=tests/install.sh
. "$WORK/tests/install.sh"
# LuCI for the login and the view, curl for the HTTP checks.
install_treadle luci curl
[ "$rc" -eq 0 ] && ok "package installed cleanly" \
	|| { cat "$OUT/install.log"; bad "package manager exited $rc"; }
command -v sing-box >/dev/null 2>&1 || die "sing-box was not pulled in as a dependency"
ok "$(sing-box version | head -n1)"
# The postinst reloads rpcd; uhttpd started before LuCI's handler existed.
/etc/init.d/uhttpd restart
wait_for 15 sh -c 'curl -s -o /dev/null http://127.0.0.1/cgi-bin/luci/' \
	|| die "uhttpd does not answer"
wait_for 15 sh -c 'ubus list luci.treadle >/dev/null 2>&1' \
	|| die "rpcd did not register luci.treadle"
ok "rpcd serves luci.treadle"

# --- rpcd ACLs -----------------------------------------------------------------

step "rpcd ACLs through /ubus"
# A read-only login: the access a LuCI user granted only Treadle's read side
# (plus luci-base, which every LuCI user has) would get.
cat >> /etc/config/rpcd <<EOF

config login
	option username 'reader'
	option password '$(uhttpd -m system-test)'
	list read 'unauthenticated'
	list read 'luci-base'
	list read 'luci-app-treadle'
EOF
/etc/init.d/rpcd restart
wait_for 15 sh -c 'ubus list luci.treadle >/dev/null 2>&1' || die "rpcd did not come back"
ROOT=$(login root '')
READER=$(login reader system-test)
[ -n "$ROOT" ] || die "root cannot log in through /ubus"
[ -n "$READER" ] || die "the read-only login cannot log in through /ubus"
ok "root and read-only sessions"

# A read method may refuse the empty argument set or fail inside; only
# "Access denied" (-32002) or "Method not found" (-32601) means the ACL and
# the handler disagree. Write methods must be refused before they run.
for m in $(jsonfilter -i "$ACL" -e '@["luci-app-treadle"].read.ubus["luci.treadle"][*]'); do
	r=$(rpc "$READER" luci.treadle "$m")
	case "$r" in
		*'"code":-32002'*|*'"code":-32601'*) bad "read-only session cannot call $m: $r" ;;
		*) ok "read-only session may call $m" ;;
	esac
done
for m in $(jsonfilter -i "$ACL" -e '@["luci-app-treadle"].write.ubus["luci.treadle"][*]'); do
	r=$(rpc "$READER" luci.treadle "$m")
	case "$r" in
		*'"code":-32002'*) ok "read-only session refused $m" ;;
		*) bad "read-only session NOT refused $m: $r" ;;
	esac
done
case "$(rpc "$NULL_SID" luci.treadle get_status)" in
	*'"code":-32002'*) ok "anonymous session refused" ;;
	*) bad "anonymous session not refused" ;;
esac
case "$(rpc "$READER" uci get '{"config":"treadle","section":"global"}')" in
	*'"values"'*) ok "read-only session may read the treadle config" ;;
	*) bad "read-only session cannot read the treadle config" ;;
esac
case "$(rpc "$READER" uci set '{"config":"treadle","section":"global","values":{"enabled":"1"}}')" in
	*'"code":-32002'*) ok "read-only session may not write it" ;;
	*) bad "read-only session wrote the treadle config" ;;
esac

# --- LuCI ----------------------------------------------------------------------

step "LuCI"
code=$(curl -s -c "$OUT/cookies" -o /dev/null -w '%{http_code}' \
	--data 'luci_username=root&luci_password=' http://127.0.0.1/cgi-bin/luci/)
[ "$code" = 302 ] && ok "LuCI login" || bad "LuCI login returned $code"
curl -s -b "$OUT/cookies" -o "$OUT/page.html" http://127.0.0.1/cgi-bin/luci/admin/services/treadle
grep -q "instantiateView('treadle/main')" "$OUT/page.html" \
	&& ok "the Treadle view is served" || bad "the Treadle view is not served"

# --- firewall ------------------------------------------------------------------

step "firewall (tproxy)"
uci set treadle.inbounds.mode=tproxy
uci commit treadle
/usr/libexec/treadle/firewall.sh start >"$OUT/fw.log" 2>&1 \
	&& ok "firewall.sh start" || bad "firewall.sh start: $(tail -n 5 "$OUT/fw.log")"
if nft list table inet treadle >"$OUT/ruleset" 2>&1; then
	ok "inet treadle loaded"
	grep -q tproxy "$OUT/ruleset" && ok "the ruleset carries the tproxy rule" \
		|| bad "no tproxy rule in the ruleset"
else
	bad "inet treadle not loaded: $(cat "$OUT/ruleset")"
fi
ip rule show | grep -q 'lookup 100' && ok "the policy rule is in place" || bad "no policy rule"
/usr/libexec/treadle/firewall.sh start >/dev/null 2>&1
has_ruleset && ok "a second start swaps the ruleset in place" || bad "a second start lost the ruleset"
/usr/libexec/treadle/firewall.sh stop >/dev/null 2>&1
no_ruleset && ok "firewall.sh stop removes it" || bad "the ruleset is left after stop"

# --- service -------------------------------------------------------------------

step "service through procd"
r=$(rpc "$ROOT" luci.treadle set_enabled '{"enabled":true}')
case "$r" in *'"ok":true'*) ok "set_enabled true" ;; *) bad "set_enabled true: $r" ;; esac
wait_for 30 running && ok "procd runs sing-box" \
	|| bad "sing-box is not running: $(ubus call service list '{"name":"treadle"}' | head -c 400)"
has_ruleset && ok "the ruleset is up with the service" || bad "no ruleset with the service"

# A change staged and applied the way Treadle's Save & Apply does it (a plain
# `uci apply`, no rollback) reaches the service trigger, and a change to the
# generated config restarts sing-box. Not `uci commit`: no LuCI ACL grants
# it on 24.10, so a session there cannot call it at all.
rpc "$ROOT" uci set '{"config":"treadle","section":"global","values":{"log_level":"debug"}}' >/dev/null
r=$(rpc "$ROOT" uci apply '{"rollback":false}')
case "$r" in *'"result":[0]'*) ok "Save & Apply through /ubus" ;; *) bad "uci apply: $r" ;; esac
wait_for 30 sh -c 'logread | grep -q "sing-box config changed, restarting sing-box"' \
	&& ok "applying a change reloads the service" || bad "no reload after applying a change"
wait_for 30 running && ok "running after the reload" || bad "not running after the reload"

# Treadle managing the groups runs active-watch and fail-watch with the clash
# API flag off, and switching back removes them again.
instance() {
	[ "$(ubus call service list '{"name":"treadle"}' 2>/dev/null \
		| jsonfilter -e "@.treadle.instances.$1.running" 2>/dev/null)" = true ]
}
watchers() { instance active_watch && instance fail_watch; }
no_watchers() { ! instance active_watch && ! instance fail_watch; }
rpc "$ROOT" uci set '{"config":"treadle","section":"global","values":{"group_manager":"treadle","clash_api_enabled":"0"}}' >/dev/null
rpc "$ROOT" uci apply '{"rollback":false}' >/dev/null
wait_for 30 watchers \
	&& ok "group_manager=treadle runs active-watch and fail-watch" \
	|| bad "watchers with group_manager=treadle: $(ubus call service list '{"name":"treadle"}' | jsonfilter -e '@.treadle.instances' | head -c 400)"
running && ok "sing-box runs its managed config" || bad "sing-box not running with group_manager=treadle"
# fail-watch counts sing-box's connection errors per outbound from the live
# log: a selector-named line (1.14) and a member-named one (1.12/1.13), in the
# same second, are both counted; `direct` is not. Lines in sing-box's format.
sleep 2
for l in "selector[sys-grp]: dial tcp: i/o timeout" "anytls[NODE-01]: connection refused" "direct[direct]: i/o timeout"; do
	logger -t sing-box "ERROR[0001] [1 5.0s] connection: open connection to example.com:443 using outbound/$l"
done
CE=/var/etc/treadle/.conn-errors.json
wait_for 10 sh -c "jsonfilter -i $CE -e '@.errors[\"NODE-01\"][0]' >/dev/null 2>&1"
[ -n "$(jsonfilter -i "$CE" -e '@.errors["sys-grp"][0]' 2>/dev/null)" ] \
	&& [ -n "$(jsonfilter -i "$CE" -e '@.errors["NODE-01"][0]' 2>/dev/null)" ] \
	&& [ -z "$(jsonfilter -i "$CE" -e '@.errors.direct' 2>/dev/null)" ] \
	&& ok "fail-watch counts connection errors per outbound from the log" \
	|| bad "fail-watch: $(cat "$CE" 2>/dev/null)"
rpc "$ROOT" uci set '{"config":"treadle","section":"global","values":{"group_manager":"singbox"}}' >/dev/null
rpc "$ROOT" uci apply '{"rollback":false}' >/dev/null
wait_for 30 no_watchers && ok "group_manager=singbox removes them again" \
	|| bad "watchers left after group_manager=singbox"

rpc "$ROOT" luci.treadle stop >/dev/null
wait_for 15 stopped && ok "stop" || bad "sing-box still running after stop"
[ -e /var/run/treadle.paused ] && ok "stop leaves the pause marker" || bad "no pause marker"
no_ruleset && ok "stop removes the ruleset" || bad "the ruleset is left after stop"

rpc "$ROOT" luci.treadle start >/dev/null
wait_for 30 running && ok "start" || bad "sing-box not running after start"

r=$(rpc "$ROOT" luci.treadle set_enabled '{"enabled":false}')
case "$r" in *'"ok":true'*) ok "set_enabled false" ;; *) bad "set_enabled false: $r" ;; esac
wait_for 15 stopped && ok "disabling stops sing-box" || bad "sing-box still running when disabled"
no_ruleset && ok "and removes the ruleset" || bad "the ruleset is left when disabled"

# --- summary -------------------------------------------------------------------

if [ "$fail" -gt 0 ]; then
	printf '\nTreadle log:\n'
	logread | grep -E 'treadle|sing-box' | tail -n 40
fi
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
