#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# End-to-end smoke test, run as root inside an OpenWrt rootfs container:
#
#   docker run --rm -v "$PWD:/work" openwrt/rootfs:x86_64-25.12.4 \
#       /bin/sh /work/tests/smoke.sh
#
# Installs the package built into dist/ (apk or ipk, whichever the image's
# package manager takes) together with the real sing-box from the OpenWrt
# feed, serves the synthetic subscriptions in tests/fixtures/sub/ over
# loopback HTTP, syncs them through the rpcd handler, then generates every
# config shape build-config can emit and runs `sing-box check` on each.
#
# Nothing here needs procd, rpcd or a network interface: the handler and
# the generators are called directly, the way rpcd and the init script
# call them.

set -u

WORK=/work
FIX="$WORK/tests/fixtures"
HANDLER=/usr/libexec/rpcd/luci.treadle
BUILD=/usr/libexec/treadle/build-config
OUT=/tmp/smoke
PORT=8080

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf 'FAIL %s\n' "$*"; }
die()  { printf 'FATAL %s\n' "$*"; exit 1; }
step() { printf '\n== %s\n' "$*"; }

mkdir -p "$OUT" /var/lock /var/run /tmp/dnsmasq.d

# --- install -----------------------------------------------------------------

step "install"
if command -v apk >/dev/null 2>&1; then
	PKG=$(ls "$WORK"/dist/*.apk 2>/dev/null | head -n1)
	[ -n "$PKG" ] || die "no .apk in dist/"
	apk update >/dev/null || die "apk update failed"
	apk add uhttpd >/dev/null || die "could not install uhttpd"
	apk add --allow-untrusted "$PKG" > "$OUT/install.log" 2>&1
	rc=$?
else
	PKG=$(ls "$WORK"/dist/*.ipk 2>/dev/null | head -n1)
	[ -n "$PKG" ] || die "no .ipk in dist/"
	opkg update >/dev/null || die "opkg update failed"
	opkg install uhttpd >/dev/null || die "could not install uhttpd"
	opkg install "$PKG" > "$OUT/install.log" 2>&1
	rc=$?
fi
cat "$OUT/install.log"
# The package's own files must land whatever the post-install script does;
# a post-install error is reported separately so it is visible, not fatal.
[ "$rc" -eq 0 ] && ok "package installed cleanly" \
	|| bad "package manager exited $rc (see install log above)"
for f in "$HANDLER" "$BUILD" /etc/init.d/treadle /etc/config/treadle \
         /usr/share/rpcd/acl.d/luci-app-treadle.json \
         /www/luci-static/resources/view/treadle/main.js; do
	[ -e "$f" ] || die "missing after install: $f"
done
ok "package files present"
command -v sing-box >/dev/null 2>&1 || die "sing-box was not pulled in as a dependency"
ok "$(sing-box version | head -n1)"

# --- rpcd handler basics -----------------------------------------------------

step "rpcd handler"
"$HANDLER" list > "$OUT/list.json" || bad "handler list exited non-zero"
jsonfilter -i "$OUT/list.json" -e '@.get_status' >/dev/null \
	&& ok "handler lists its methods" || bad "handler list output is not the method table"
echo '{}' | "$HANDLER" call get_status > "$OUT/status.json"
jsonfilter -i "$OUT/status.json" -e '@.version' >/dev/null \
	&& ok "get_status reports the sing-box version" || bad "get_status: $(cat "$OUT/status.json")"
echo '{"logs":10}' | "$HANDLER" call get_dashboard > "$OUT/dash.json"
jsonfilter -i "$OUT/dash.json" -e '@.status.version' >/dev/null \
	&& jsonfilter -i "$OUT/dash.json" -e '@.groups' >/dev/null \
	&& jsonfilter -i "$OUT/dash.json" -e '@.stats' >/dev/null \
	&& jsonfilter -i "$OUT/dash.json" -e '@.logs' >/dev/null \
	&& ok "get_dashboard returns status, groups, stats and logs" \
	|| bad "get_dashboard: $(head -c 300 "$OUT/dash.json")"
echo '{}' | "$HANDLER" call get_dashboard > "$OUT/dash-nolog.json"
jsonfilter -i "$OUT/dash-nolog.json" -e '@.logs' >/dev/null 2>&1 \
	&& bad "get_dashboard read the logs without being asked" \
	|| ok "get_dashboard skips the logs unless asked"

# --- subscriptions -----------------------------------------------------------

step "subscriptions"
uhttpd -f -p "127.0.0.1:$PORT" -h "$FIX/sub" &
HTTPD=$!
trap 'kill "$HTTPD" 2>/dev/null' EXIT
sleep 1

# id | fixture | expected node count
SUBS="0123456789abcd01 uri.txt 9
0123456789abcd02 uri-base64.txt 9
0123456789abcd03 clash.yaml 7
0123456789abcd04 sing-box.json 4"

# Loops read from here-documents, not a pipe, so they run in this shell and
# the pass/fail counters survive them.
while read -r id file _; do
	uci set "treadle.$id=subscription"
	uci set "treadle.$id.name=fixture $file"
	uci set "treadle.$id.url=http://127.0.0.1:$PORT/$file"
	uci set "treadle.$id.enabled=1"
done <<EOF
$SUBS
EOF
uci commit treadle

while read -r id file want; do
	printf '{"id":"%s"}' "$id" | "$HANDLER" call sync_subscription > "$OUT/sync-$id.json"
	status=$(jsonfilter -i "$OUT/sync-$id.json" -e '@.status')
	got=$(jsonfilter -i "$OUT/sync-$id.json" -e '@.node_count')
	if [ "$status" = "ok" ] && [ "$got" = "$want" ]; then
		ok "$file: $got nodes"
	else
		bad "$file: status=$status nodes=$got, want ok/$want — $(cat "$OUT/sync-$id.json")"
	fi
done <<EOF
$SUBS
EOF

# Re-syncing an unchanged subscription must not rewrite its node file.
nf=/etc/treadle/nodes/0123456789abcd01.json
before=$(date -r "$nf" +%s)
sleep 2
printf '{"id":"0123456789abcd01"}' | "$HANDLER" call sync_subscription > "$OUT/resync.json"
after=$(date -r "$nf" +%s)
[ "$(jsonfilter -i "$OUT/resync.json" -e '@.status')" = "ok" ] && [ "$before" = "$after" ] \
	&& ok "unchanged re-sync left the node file untouched" \
	|| bad "re-sync: status=$(jsonfilter -i "$OUT/resync.json" -e '@.status') mtime $before -> $after"

# --- routing fixture ---------------------------------------------------------

# A regex urltest group over every imported node as the final outbound,
# plus one rule with a domain condition, so the advanced build emits
# groups, rules and DNS rules rather than an all-direct config.
uci batch <<'EOF'
set treadle.0123456789abcd10=node
set treadle.0123456789abcd10.type=urltest
set treadle.0123456789abcd10.tag=ALL
set treadle.0123456789abcd10.urltest_mode=regex
set treadle.0123456789abcd10.urltest_regex=.*
set treadle.routing.final_outbound=ALL
set treadle.0123456789abcd20=rule
set treadle.0123456789abcd20.enabled=1
set treadle.0123456789abcd20.order=1
set treadle.0123456789abcd20.outbound=HK-01
set treadle.0123456789abcd21=condition
set treadle.0123456789abcd21.rule=0123456789abcd20
set treadle.0123456789abcd21.kind=domain_suffix
add_list treadle.0123456789abcd21.value=example.com
set treadle.global.mode=advanced
commit treadle
EOF

# --- firewall bypass list ----------------------------------------------------

# The container cannot load nftables rules, but the bypass list is plain
# text built from `uci show`: run that function on its own and compare.
step "firewall bypasses"
uci batch <<'EOF'
set treadle.0123456789abcd30=bypass
set treadle.0123456789abcd30.kind=mac
set treadle.0123456789abcd30.value=00:11:22:33:44:55
set treadle.0123456789abcd31=bypass
set treadle.0123456789abcd31.kind=ip
set treadle.0123456789abcd31.value=192.168.1.50
set treadle.0123456789abcd32=bypass
set treadle.0123456789abcd32.kind=ip
set treadle.0123456789abcd32.enabled=0
set treadle.0123456789abcd32.value=192.168.1.51
set treadle.0123456789abcd33=bypass
set treadle.0123456789abcd33.kind=ip
set treadle.0123456789abcd33.value=2001:db8::1
commit treadle
EOF
sed -n '/^emit_bypasses() {/,/^}/p' /usr/libexec/treadle/firewall.sh > "$OUT/emit_bypasses.sh"
# shellcheck disable=SC1091
( . "$OUT/emit_bypasses.sh"; emit_bypasses ) | sed 's/^[[:space:]]*//' > "$OUT/bypasses.txt"
printf '%s\n' "ether saddr 00:11:22:33:44:55 accept" "ip saddr 192.168.1.50 accept" \
	"ip6 saddr 2001:db8::1 accept" > "$OUT/bypasses.want"
if cmp -s "$OUT/bypasses.txt" "$OUT/bypasses.want"; then
	ok "bypass entries parsed (disabled one skipped)"
else
	# busybox on OpenWrt ships without diff, so show both sides.
	bad "bypass entries differ"
	sed 's/^/    want: /' "$OUT/bypasses.want"
	sed 's/^/    got:  /' "$OUT/bypasses.txt"
fi

# --- generated configs -------------------------------------------------------

check_config() {
	label="$1"; file="$2"
	if sing-box check -c "$file" > "$OUT/check.log" 2>&1; then
		ok "sing-box check: $label"
	else
		bad "sing-box check: $label"
		sed 's/^/    /' "$OUT/check.log"
	fi
}

build() {
	label="$1"; shift
	file="$OUT/$(echo "$label" | tr ' /' '__').json"
	if "$BUILD" "$@" "$file" > "$OUT/build.log" 2>&1; then
		check_config "$label" "$file"
	else
		bad "build-config failed: $label"
		sed 's/^/    /' "$OUT/build.log"
	fi
}

step "configs"
for mode in tproxy tproxy_mixed tun mixed; do
	uci set treadle.inbounds.mode="$mode"
	uci commit treadle
	build "advanced / $mode"
done
uci set treadle.inbounds.mode=tproxy
uci commit treadle

grep -q '"tag": "HK-01"' "$OUT/advanced___tproxy.json" \
	&& ok "rule outbound HK-01 is in the running config" \
	|| bad "rule outbound HK-01 missing from the running config"

# Every imported node must reach sing-box, not just a config that passes
# check: the regex group expands to all of them, and the probe config
# carries each one (plus its own direct outbound).
NODES=29
members=$(jsonfilter -i "$OUT/advanced___tproxy.json" \
	-e '@.outbounds[@.tag="ALL"].outbounds[*]' | wc -l)
[ "$members" -eq "$NODES" ] && ok "regex group ALL has all $NODES nodes" \
	|| bad "regex group ALL has $members members, want $NODES"

uci set treadle.global.clash_api_enabled=1
uci commit treadle
build "advanced / clash api"
build "probe" --probe
probed=$(jsonfilter -i "$OUT/probe.json" -e '@.outbounds[@.type!="direct"].tag' | wc -l)
[ "$probed" -eq "$NODES" ] && ok "probe config dials all $NODES nodes" \
	|| bad "probe config has $probed nodes, want $NODES"
uci set treadle.global.clash_api_enabled=0
uci set treadle.global.mode=basic
uci commit treadle
build "basic"

# get_config builds a preview through the same generator; make sure the
# read-side RPC path works end to end too.
echo '{}' | "$HANDLER" call get_config > "$OUT/get_config.json"
[ -z "$(jsonfilter -i "$OUT/get_config.json" -e '@.error' 2>/dev/null)" ] \
	&& jsonfilter -i "$OUT/get_config.json" -e '@.json' | grep -q outbounds \
	&& ok "get_config returns a preview" \
	|| bad "get_config: $(head -c 400 "$OUT/get_config.json")"

# --- removal -----------------------------------------------------------------

# The init script installs these cron jobs on start; procd is not running
# here, so put them in place by hand, as a started service would have.
step "removal"
mkdir -p /etc/crontabs
printf '%s\n' "17 * * * * /usr/libexec/treadle/hourly" \
	"*/5 * * * * /usr/libexec/treadle/watchdog" >> /etc/crontabs/root
grep -qxF "/etc/treadle/nodes/" /etc/sysupgrade.conf \
	&& ok "post-install registered the node directory with sysupgrade" \
	|| bad "post-install did not add /etc/treadle/nodes/ to sysupgrade.conf"

if [ -x /usr/lib/opkg/info/luci-app-treadle.prerm ]; then
	# opkg runs the old package's prerm on every upgrade.
	/usr/lib/opkg/info/luci-app-treadle.prerm upgrade 9.9.9-r1 >/dev/null 2>&1
	[ "$(grep -c /usr/libexec/treadle/ /etc/crontabs/root)" -eq 2 ] \
		&& [ -x /etc/init.d/treadle ] \
		&& ok "prerm on upgrade leaves cron jobs and service alone" \
		|| bad "prerm on upgrade removed cron jobs or the service"
	opkg remove luci-app-treadle > "$OUT/remove.log" 2>&1
else
	apk del luci-app-treadle > "$OUT/remove.log" 2>&1
fi
rc=$?
[ "$rc" -eq 0 ] && ok "package removed cleanly" \
	|| { bad "removal exited $rc"; sed 's/^/    /' "$OUT/remove.log"; }
grep -q /usr/libexec/treadle/ /etc/crontabs/root \
	&& bad "cron jobs left behind after removal" \
	|| ok "removal cleared the cron jobs"
grep -qF "/etc/treadle/nodes/" /etc/sysupgrade.conf \
	&& bad "sysupgrade entry left behind after removal" \
	|| ok "removal cleared the sysupgrade entry"

# --- summary -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
