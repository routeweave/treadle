#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# End-to-end smoke test, run as root inside an OpenWrt rootfs container:
#
#   docker run --rm -v "$PWD:/work" openwrt/rootfs:x86_64-25.12.5 \
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
# SMOKE_SINGBOX (a path under /work) swaps in another sing-box build after the
# package's own dependency is installed. CI uses it to check every config shape
# against an upstream release newer than the OpenWrt feed carries.
if [ -n "${SMOKE_SINGBOX:-}" ]; then
	# busybox in the OpenWrt rootfs has no `install` applet.
	cp "$SMOKE_SINGBOX" /usr/bin/sing-box && chmod 0755 /usr/bin/sing-box \
		|| die "could not install $SMOKE_SINGBOX"
fi
SB_VERSION=$(sing-box version | head -n1)
ok "$SB_VERSION"
# The config stamp: the version line plus the Go release (treadlelib.singbox_stamp).
SB_STAMP="$SB_VERSION$(sing-box version | sed -n 's/^Environment: go\([0-9][0-9]*\.[0-9][0-9]*\).*/ go\1/p' | head -n 1)"
# Mirrors treadlelib.singbox_caps: http_client replaces download_detour at 1.14.
# ECH needs a sing-box built with Go 1.24+ (24.10's package is not).
SB_ECH=0
sing-box version | sed -n 's/^Environment: go\([0-9]*\)\.\([0-9]*\).*/\1 \2/p' \
	| awk '{ exit !($1 > 1 || ($1 == 1 && $2 >= 24)) }' && SB_ECH=1
SB_HTTP_CLIENT=0
echo "$SB_VERSION" | awk '{ split($3, v, "."); exit !(v[1] > 1 || (v[1] == 1 && v[2] >= 14)) }' \
	&& SB_HTTP_CLIENT=1
# 1.14 also brings tun exclude_mac_address and the optimistic DNS cache, and
# keys the DNS cache by server (independent_cache is deprecated).
SB_114=$SB_HTTP_CLIENT
# ...and rules match ICMP with `network: icmp` from 1.13.
SB_ICMP=0
echo "$SB_VERSION" | awk '{ split($3, v, "."); exit !(v[1] > 1 || (v[1] == 1 && v[2] >= 13)) }' \
	&& SB_ICMP=1

# --- rpcd handler basics -----------------------------------------------------

step "rpcd handler"
"$HANDLER" list > "$OUT/list.json" || bad "handler list exited non-zero"
jsonfilter -i "$OUT/list.json" -e '@.get_status' >/dev/null \
	&& ok "handler lists its methods" || bad "handler list output is not the method table"
echo '{}' | "$HANDLER" call get_status > "$OUT/status.json"
jsonfilter -i "$OUT/status.json" -e '@.version' >/dev/null \
	&& ok "get_status reports the sing-box version" || bad "get_status: $(cat "$OUT/status.json")"
# The package manager's own answer, not the files the handler reads.
if command -v apk >/dev/null 2>&1; then
	want_pv=$(apk list -I luci-app-treadle | sed -n 's/^luci-app-treadle-\([^ ]*\) .*/\1/p')
else
	want_pv=$(opkg list-installed luci-app-treadle | sed -n 's/^luci-app-treadle - //p')
fi
got_pv=$(jsonfilter -i "$OUT/status.json" -e '@.package_version')
[ -n "$want_pv" ] && [ "$got_pv" = "$want_pv" ] \
	&& ok "get_status reports the installed Treadle version" \
	|| bad "get_status package_version '$got_pv', package manager says '$want_pv'"
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
# The package version is read once per page load, not on every tick.
[ -z "$(jsonfilter -i "$OUT/dash-nolog.json" -e '@.status.package_version' 2>/dev/null)" ] \
	&& ok "get_dashboard skips the package version unless asked" \
	|| bad "get_dashboard read the package version without being asked"
echo '{"versions":true}' | "$HANDLER" call get_dashboard > "$OUT/dash-ver.json"
[ "$(jsonfilter -i "$OUT/dash-ver.json" -e '@.status.package_version')" = "$want_pv" ] \
	&& ok "get_dashboard reports the package version when asked" \
	|| bad "get_dashboard versions: $(head -c 300 "$OUT/dash-ver.json")"

# The Status box shows every sing-box line, unfiltered, including the ICMP
# echo session timeout that sing-box 1.13 logs at error level (decision 0150).
# The container has no syslog, so a stand-in logread supplies the lines. The
# JSON encoder escapes the slash in "i/o", so that line is matched on its
# address and the start of its error text.
mkdir -p "$OUT/fakebin"
cat > "$OUT/fakebin/logread" <<'EOF'
#!/bin/sh
echo 'Fri Oct  2 09:12:11 2026 daemon.err sing-box[7051]: ERROR[0357] [123 12.0s] outbound/direct[direct]: receive ICMP echo reply: read ip 192.0.2.10: i/o timeout'
echo 'Fri Oct  2 09:12:12 2026 daemon.err sing-box[7051]: ERROR[0358] outbound/direct[direct]: dial tcp 192.0.2.20:443: connection refused'
echo 'Fri Oct  2 09:12:13 2026 daemon.err sing-box[7051]: ERROR[0359] outbound/direct[direct]: receive ICMP echo reply: read ip 192.0.2.10: no route to host'
EOF
chmod +x "$OUT/fakebin/logread"
echo '{"lines":20}' | PATH="$OUT/fakebin:$PATH" "$HANDLER" call get_logs > "$OUT/logs.json"
grep -q 'read ip 192.0.2.10: i' "$OUT/logs.json" \
	&& grep -q 'connection refused' "$OUT/logs.json" \
	&& grep -q 'no route to host' "$OUT/logs.json" \
	&& ok "get_logs shows every sing-box line, ICMP timeout included" \
	|| bad "get_logs dropped a sing-box line: $(head -c 300 "$OUT/logs.json")"
echo '{"lines":20}' | PATH="$OUT/fakebin:$PATH" "$HANDLER" call get_log > "$OUT/log-full.json"
grep -q 'read ip 192.0.2.10: i' "$OUT/log-full.json" \
	&& ok "get_log (full log) still shows the ICMP timeout" \
	|| bad "get_log hid the ICMP timeout; the full log must stay complete"

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
0123456789abcd04 sing-box.json 4
0123456789abcd05 sing-box-banner.json 2"

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

# The Status page's subscription ages come from the router's clock, as
# seconds since last_sync, so the browser's time zone cannot skew them.
echo '{}' | "$HANDLER" call get_dashboard > "$OUT/dash-subs.json"
age=$(jsonfilter -i "$OUT/dash-subs.json" -e '@.subs[@.id="0123456789abcd01"].age_s')
[ -n "$age" ] && [ "$age" -ge 0 ] && [ "$age" -lt 600 ] \
	&& ok "get_dashboard reports a just-synced subscription's age" \
	|| bad "subscription age '$age': $(head -c 300 "$OUT/dash-subs.json")"

# Each node's payload is stored as the outbound object itself. (Files from an
# older Treadle hold it as a JSON string; the ECH fixture below is one, and
# build-config must still read it.)
[ -n "$(jsonfilter -i "$nf" -e '@[0].payload.type')" ] \
	&& [ "$(jsonfilter -i "$nf" -e '@[0].payload.tag')" = "$(jsonfilter -i "$nf" -e '@[0].tag')" ] \
	&& ok "synced node payloads are stored as objects" \
	|| bad "node payload is not an object: $(head -c 200 "$nf")"

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
set treadle.0123456789abcd40=rule
set treadle.0123456789abcd40.enabled=1
set treadle.0123456789abcd40.order=2
set treadle.0123456789abcd40.outbound=direct
set treadle.0123456789abcd41=condition
set treadle.0123456789abcd41.rule=0123456789abcd40
set treadle.0123456789abcd41.kind=ruleset
add_list treadle.0123456789abcd41.value=sagernet/geosite-cn
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
# The shipped default is tun, and a missing option builds the same thing, so
# the conffile, the builder and the UI agree (see decision 0118 for what a
# mismatch costs). tproxy stays selectable, which the loop below covers.
shipped_mode=$(uci -q get treadle.inbounds.mode)
[ "$shipped_mode" = "tun" ] && ok "shipped inbound mode is tun" \
	|| bad "shipped inbound mode is '$shipped_mode', want tun"
uci delete treadle.inbounds.mode
uci commit treadle
build "advanced / unset mode"
unset_in=$(jsonfilter -i "$OUT/advanced___unset_mode.json" \
	-e '@.inbounds[0].type')
[ "$unset_in" = "tun" ] && ok "an unset inbound mode builds a tun inbound" \
	|| bad "an unset inbound mode builds '$unset_in', want tun"
auto_redirect=$(jsonfilter -i "$OUT/advanced___unset_mode.json" \
	-e '@.inbounds[@.type="tun"].auto_redirect')
[ "$auto_redirect" = "true" ] && ok "the default tun inbound sets auto_redirect" \
	|| bad "the default tun inbound auto_redirect is '$auto_redirect', want true"
for mode in tproxy tun mixed; do
	uci set treadle.inbounds.mode="$mode"
	uci commit treadle
	build "advanced / $mode"
done
for mode in tun tproxy; do
	uci set treadle.inbounds.mode="$mode"
	uci set treadle.inbounds.mixed_enabled=1
	uci commit treadle
	build "advanced / $mode + mixed"
	mixed_port=$(jsonfilter -i "$OUT/advanced___${mode}_+_mixed.json" \
		-e '@.inbounds[@.type="mixed"].listen_port')
	[ "$mixed_port" = "2080" ] && ok "$mode mode emits the mixed inbound when mixed_enabled is on" \
		|| bad "$mode mode mixed inbound port is '$mixed_port', want 2080"
done
uci set treadle.inbounds.mixed_enabled=0
uci set treadle.inbounds.mode=tun
uci commit treadle
build "advanced / tun no mixed"
no_mixed=$(jsonfilter -i "$OUT/advanced___tun_no_mixed.json" \
	-e '@.inbounds[@.type="mixed"].tag')
[ -z "$no_mixed" ] && ok "no mixed inbound when mixed_enabled is off" \
	|| bad "mixed inbound present with mixed_enabled off"
# The bypass list above holds one MAC entry. From 1.14 it goes in the tun
# inbound's exclude_mac_address (with auto-route on); before that it is left
# out and named for the Status warning.
mac_tun=$(jsonfilter -i "$OUT/advanced___tun_no_mixed.json" \
	-e '@.inbounds[@.type="tun"].exclude_mac_address[*]')
if [ "$SB_114" = 1 ]; then
	[ "$mac_tun" = "00:11:22:33:44:55" ] && ok "tun inbound excludes the bypassed MAC" \
		|| bad "tun exclude_mac_address is '$mac_tun', want 00:11:22:33:44:55"
else
	[ -z "$mac_tun" ] && grep -q "MAC bypass in tun mode needs sing-box 1.14" "$OUT/build.log" \
		&& ok "no exclude_mac_address before sing-box 1.14" \
		|| bad "MAC bypass on $SB_VERSION: '$mac_tun', log: $(head -c 200 "$OUT/build.log")"
	echo '{}' | "$HANDLER" call get_status > "$OUT/status-mac.json"
	[ "$(jsonfilter -i "$OUT/status-mac.json" -e '@.compat[@.key="tun_mac"].items[0]')" = "00:11:22:33:44:55" ] \
		&& ok "get_status names the inert MAC bypass, for the Status warning" \
		|| bad "get_status compat: $(cat "$OUT/status-mac.json")"
fi
uci set treadle.inbounds.tun_auto_route=0
uci commit treadle
build "advanced / tun no auto-route"
[ -z "$(jsonfilter -i "$OUT/advanced___tun_no_auto-route.json" \
	-e '@.inbounds[@.type="tun"].exclude_mac_address[*]')" ] \
	&& ok "no exclude_mac_address without auto-route" \
	|| bad "exclude_mac_address emitted without auto-route"
uci set treadle.inbounds.tun_auto_route=1
uci commit treadle
uci set treadle.inbounds.mode=tproxy
uci commit treadle

# Pings go direct in tun mode, ahead of every user rule, as tproxy never hands
# ICMP to sing-box. 1.12 has no `icmp` network, so nothing is emitted there.
icmp_tun=$(jsonfilter -i "$OUT/advanced___tun.json" \
	-e '@.route.rules[@.network[0]="icmp"].outbound')
icmp_tproxy=$(jsonfilter -i "$OUT/advanced___tproxy.json" \
	-e '@.route.rules[@.network[0]="icmp"].outbound')
if [ "$SB_ICMP" = 1 ]; then
	[ "$icmp_tun" = "direct" ] && ok "tun route sends ICMP direct" \
		|| bad "tun route ICMP outbound is '$icmp_tun', want direct"
else
	[ -z "$icmp_tun" ] && ok "no ICMP rule before sing-box 1.13" \
		|| bad "ICMP rule emitted for $SB_VERSION"
fi
[ -z "$icmp_tproxy" ] && ok "tproxy route has no ICMP rule" \
	|| bad "tproxy route has an ICMP rule ('$icmp_tproxy')"

# In tun mode nothing ahead of sing-box bypasses CGNAT the way firewall.sh
# does for tproxy, so the route has to send it direct itself.
cgnat=$(jsonfilter -i "$OUT/advanced___tun.json" \
	-e '@.route.rules[@.ip_cidr[0]="100.64.0.0/10"].outbound')
[ "$cgnat" = "direct" ] && ok "tun route sends CGNAT direct" \
	|| bad "tun route CGNAT outbound is '$cgnat', want direct"

grep -q '"tag": "HK-01"' "$OUT/advanced___tproxy.json" \
	&& ok "rule outbound HK-01 is in the running config" \
	|| bad "rule outbound HK-01 missing from the running config"

# Hysteria2 port hopping survives the sanitiser: the sing-box fixture's valid
# range is kept and its bare and reversed entries dropped; the Clash fixture's
# `ports` / `hop-interval` are translated to sing-box's shape.
hop() {
	jsonfilter -i "$OUT/advanced___tproxy.json" \
		-e "@.outbounds[@.tag=\"$1\"].$2" | tr '\n' ' '
}
got="$(hop NODE-04 'server_ports[*]')/$(hop NODE-04 hop_interval)"
[ "$got" = "20000:30000 /30s " ] && ok "sing-box hysteria2 keeps valid server_ports" \
	|| bad "NODE-04 server_ports/hop_interval are '$got'"
got="$(hop SG-05 'server_ports[*]')/$(hop SG-05 hop_interval)"
[ "$got" = "443:443 20000:30000 /30s " ] && ok "clash hysteria2 ports map to server_ports" \
	|| bad "SG-05 server_ports/hop_interval are '$got'"
# A link's `mport` carries the range but no interval.
got="$(hop HK-06 'server_ports[*]')/$(hop HK-06 hop_interval)"
[ "$got" = "20000:30000 /" ] && ok "uri hysteria2 mport maps to server_ports" \
	|| bad "HK-06 server_ports/hop_interval are '$got'"

# Every imported node must reach sing-box, not just a config that passes
# check: the regex group expands to all of them, and the probe config
# carries each one (plus its own direct outbound).
NODES=31
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
uci commit treadle

# With "Proxy router traffic" off, the router's own traffic stays out of the
# tunnel. tproxy gets that from firewall.sh; a tun inbound captures local
# output too, so every local uid is excluded there. On (the default), the
# router's traffic stays in the tunnel.
uci set treadle.inbounds.mode=tun
uci set treadle.inbounds.tproxy_self=0
uci commit treadle
build "tun / router direct"
uid_off=$(jsonfilter -i "$OUT/tun___router_direct.json" \
	-e '@.inbounds[@.type="tun"].exclude_uid_range[0]')
[ "$uid_off" = "0:65535" ] && ok "tun inbound excludes local uids when router traffic goes direct" \
	|| bad "tun inbound exclude_uid_range is '$uid_off', want 0:65535"
uid_on=$(jsonfilter -i "$OUT/advanced___tun.json" \
	-e '@.inbounds[@.type="tun"].exclude_uid_range[0]')
[ -z "$uid_on" ] && ok "tun inbound keeps local uids when router traffic is proxied" \
	|| bad "tun inbound has exclude_uid_range '$uid_on' with router traffic proxied"
uci set treadle.inbounds.tproxy_self=1
uci set treadle.inbounds.mode=tproxy
uci commit treadle

# With no proxy default, a remote DNS server given by hostname must still
# get a detour, or sing-box finds no resolver for its address and rejects
# the config.
remote_was=$(uci -q get treadle.dns.remote_server)
uci set treadle.dns.remote_server=https://dns.example.com/dns-query
uci set treadle.routing.final_outbound=direct
uci commit treadle
build "advanced direct / remote DNS by hostname"
detour=$(jsonfilter -i "$OUT/advanced_direct___remote_DNS_by_hostname.json" \
	-e '@.dns.servers[@.tag="remote"].detour')
[ "$detour" = "direct" ] && ok "remote DNS goes out direct with no proxy default" \
	|| bad "remote DNS detour is '$detour', want direct"
uci set treadle.routing.final_outbound=ALL
uci set treadle.dns.remote_server="$remote_was"
uci commit treadle

# A local DNS server given by hostname would resolve itself through itself
# (its lookups go out direct, whose resolver is local), so it gets a
# bootstrap resolver at a literal IP. The probe config shares the entry.
local_was=$(uci -q get treadle.dns.local_server)
uci set treadle.dns.local_server=https://dns.example.com/dns-query
uci commit treadle
build "local DNS by hostname"
build "probe / local DNS by hostname" --probe
for f in local_DNS_by_hostname probe___local_DNS_by_hostname; do
	dr=$(jsonfilter -i "$OUT/$f.json" -e '@.dns.servers[@.tag="local"].domain_resolver')
	bs=$(jsonfilter -i "$OUT/$f.json" -e '@.dns.servers[@.tag="local-bootstrap"].type')
	[ "$dr" = "local-bootstrap" ] && [ "$bs" = "udp" ] \
		&& ok "$f: local resolves its hostname via local-bootstrap" \
		|| bad "$f: local domain_resolver '$dr', bootstrap type '$bs'"
done
uci set treadle.dns.local_server="$local_was"
uci commit treadle

# get_config builds a preview through the same generator; make sure the
# read-side RPC path works end to end too.
echo '{}' | "$HANDLER" call get_config > "$OUT/get_config.json"
[ -z "$(jsonfilter -i "$OUT/get_config.json" -e '@.error' 2>/dev/null)" ] \
	&& jsonfilter -i "$OUT/get_config.json" -e '@.json' | grep -q outbounds \
	&& ok "get_config returns a preview" \
	|| bad "get_config: $(head -c 400 "$OUT/get_config.json")"

# --- urltest member order ----------------------------------------------------

step "member order"
SNAP=/var/etc/treadle/member-order.json
LAT=/var/etc/treadle/latency.json
now=$(date +%s)
members() {
	jsonfilter -i "$OUT/$1.json" -e '@.outbounds[@.tag="ALL"].outbounds[*]' | tr '\n' ' '
}
snapshot() {
	cat > "$SNAP" <<EOF
{ "version": 1, "seed": $1, "created_at": $now, "latency": {
  "HK-05": { "delay_ms": 70, "tested_at": $((now - 60)) },
  "SG-01": { "delay_ms": 80, "tested_at": $((now - 60)) },
  "NODE-03": { "delay_ms": 90, "tested_at": $((now - 60)) },
  "HK-06": { "delay_ms": 260, "tested_at": $((now - 60)) },
  "HK-07": { "failed": true, "tested_at": $((now - 60)) },
  "SG-05": { "delay_ms": 60, "tested_at": $((now - 86400)) } } }
EOF
}
uci set treadle.0123456789abcd10.urltest_member_order=latency
uci set treadle.0123456789abcd10.urltest_max_members=6
uci commit treadle

snapshot 12345
build "order latency"
build "order latency again"
cmp -s "$OUT/order_latency.json" "$OUT/order_latency_again.json" \
	&& ok "same snapshot builds a byte-identical config" \
	|| bad "same snapshot built two different configs"
# Word-split on purpose: one positional parameter per member tag.
# shellcheck disable=SC2046
set -- $(members order_latency)
[ "$#" -eq 6 ] && ok "max_members keeps 6 members" || bad "ALL has $# members, want 6: $*"
first3=$(printf '%s\n' "${1:-}" "${2:-}" "${3:-}" | sort | tr '\n' ' ')
[ "$first3" = "HK-05 NODE-03 SG-01 " ] && ok "fastest bucket leads the group" \
	|| bad "first three members are '$first3'"
[ "${4:-}" = "HK-06" ] && ok "slower result ranks after the fast bucket" \
	|| bad "fourth member is '${4:-}', want HK-06"
case " $* " in *" HK-07 "*) bad "fresh failure HK-07 kept despite the cap" ;;
	*) ok "fresh failure is cut by the cap" ;; esac
servers=$(for t in "$@"; do jsonfilter -i "$OUT/order_latency.json" \
	-e "@.outbounds[@.tag=\"$t\"].server"; done | sort -u | wc -l)
[ "$servers" -eq 6 ] && ok "cap prefers members on distinct servers" \
	|| bad "6 members span only $servers servers"

uci set treadle.0123456789abcd10.urltest_member_order=shuffle
uci delete treadle.0123456789abcd10.urltest_max_members
uci commit treadle
snapshot 111
build "order shuffle a"
snapshot 222
build "order shuffle b"
a=$(members order_shuffle_a); b=$(members order_shuffle_b)
[ "$(echo "$a" | wc -w)" -eq "$NODES" ] && [ "$a" != "$b" ] \
	&& ok "a new seed reorders all $NODES members" \
	|| bad "shuffle with two seeds: '$a' vs '$b'"

rm -f "$SNAP"
build "order without snapshot"
[ "$(members order_without_snapshot | wc -w)" -eq "$NODES" ] \
	&& ok "no snapshot still builds a full shuffled group" \
	|| bad "no snapshot: ALL has '$(members order_without_snapshot)'"

cat > "$LAT" <<EOF
{ "results": { "HK-05": { "delay_ms": 70, "tested_at": $now },
  "HK-07": { "error": "timeout", "tested_at": $now } } }
EOF
if "$BUILD" --order-snapshot; then
	read -r seed d f <<EOF
$(lua -e 'local t = require("luci.jsonc").parse(io.read("*a"))
print(t.seed or 0, t.latency["HK-05"].delay_ms, tostring(t.latency["HK-07"].failed))' < "$SNAP")
EOF
	[ "${seed:-0}" -gt 0 ] && [ "$d" = "70" ] && [ "$f" = "true" ] \
		&& ok "--order-snapshot records a seed and the latency results" \
		|| bad "--order-snapshot wrote seed='$seed' HK-05='$d' HK-07 failed='$f'"
else
	bad "--order-snapshot failed"
fi

rm -f "$SNAP" "$LAT"
uci delete treadle.0123456789abcd10.urltest_member_order
uci commit treadle

# --- manual nodes ------------------------------------------------------------

step "manual nodes"

# One manual node per editor feature, gathered into a manual urltest group
# set as the final outbound so every one of them reaches the built config
# and `sing-box check`.
REALITY_PK=$(sing-box generate reality-keypair | sed -n 's/^PublicKey: //p')
uci batch <<EOF
set treadle.0123456789abcd60=node
set treadle.0123456789abcd60.type=vless
set treadle.0123456789abcd60.tag=MANUAL-REALITY
set treadle.0123456789abcd60.server=192.0.2.1
set treadle.0123456789abcd60.server_port=443
set treadle.0123456789abcd60.uuid=00000000-0000-0000-0000-000000000000
set treadle.0123456789abcd60.flow=xtls-rprx-vision
set treadle.0123456789abcd60.tls_enabled=1
set treadle.0123456789abcd60.tls_sni=example.com
set treadle.0123456789abcd60.tls_reality=1
set treadle.0123456789abcd60.tls_reality_public_key=$REALITY_PK
set treadle.0123456789abcd60.tls_reality_short_id=0123abcd
set treadle.0123456789abcd61=node
set treadle.0123456789abcd61.type=trojan
set treadle.0123456789abcd61.tag=MANUAL-TROJAN
set treadle.0123456789abcd61.server=example.com
set treadle.0123456789abcd61.server_port=443
set treadle.0123456789abcd61.password=pw
add_list treadle.0123456789abcd61.tls_alpn=h2
add_list treadle.0123456789abcd61.tls_alpn=http/1.1
set treadle.0123456789abcd61.tls_min_version=1.2
set treadle.0123456789abcd61.tls_max_version=1.3
set treadle.0123456789abcd61.transport_type=httpupgrade
set treadle.0123456789abcd61.transport_httpupgrade_path=/up
set treadle.0123456789abcd61.transport_httpupgrade_host=example.org
set treadle.0123456789abcd62=node
set treadle.0123456789abcd62.type=vless
set treadle.0123456789abcd62.tag=MANUAL-XHTTP
set treadle.0123456789abcd62.server=192.0.2.1
set treadle.0123456789abcd62.server_port=443
set treadle.0123456789abcd62.uuid=00000000-0000-0000-0000-000000000000
set treadle.0123456789abcd62.tls_enabled=1
set treadle.0123456789abcd62.tls_sni=example.org
set treadle.0123456789abcd62.transport_type=xhttp
set treadle.0123456789abcd62.transport_xhttp_path=/x
set treadle.0123456789abcd63=node
set treadle.0123456789abcd63.type=anytls
set treadle.0123456789abcd63.tag=MANUAL-ANYTLS
set treadle.0123456789abcd63.server=example.com
set treadle.0123456789abcd63.server_port=443
set treadle.0123456789abcd63.password=pw
set treadle.0123456789abcd63.transport_type=ws
set treadle.0123456789abcd64=node
set treadle.0123456789abcd64.type=hysteria2
set treadle.0123456789abcd64.tag=MANUAL-HY2
set treadle.0123456789abcd64.server=example.com
set treadle.0123456789abcd64.server_port=443
set treadle.0123456789abcd64.password=pw
add_list treadle.0123456789abcd64.hy2_server_ports=20000:30000
add_list treadle.0123456789abcd64.hy2_server_ports=40000:39000
set treadle.0123456789abcd64.hy2_hop_interval=1m
set treadle.0123456789abcd64.hy2_up_mbps=50
set treadle.0123456789abcd64.hy2_down_mbps=200
set treadle.0123456789abcd65=node
set treadle.0123456789abcd65.type=vmess
set treadle.0123456789abcd65.tag=MANUAL-WS
set treadle.0123456789abcd65.server=example.com
set treadle.0123456789abcd65.server_port=443
set treadle.0123456789abcd65.uuid=00000000-0000-0000-0000-000000000000
set treadle.0123456789abcd65.transport_type=ws
set treadle.0123456789abcd65.transport_ws_path=/ws
set treadle.0123456789abcd65.transport_ws_max_early_data=2048
set treadle.0123456789abcd65.transport_ws_early_data_header=Sec-WebSocket-Protocol
set treadle.0123456789abcd65.packet_encoding=packetaddr
set treadle.0123456789abcd66=node
set treadle.0123456789abcd66.type=shadowsocks
set treadle.0123456789abcd66.tag=MANUAL-SS
set treadle.0123456789abcd66.server=example.com
set treadle.0123456789abcd66.server_port=8388
set treadle.0123456789abcd66.method=aes-256-gcm
set treadle.0123456789abcd66.password=pw
set treadle.0123456789abcd66.udp_over_tcp=1
set treadle.0123456789abcd67=node
set treadle.0123456789abcd67.type=trojan
set treadle.0123456789abcd67.tag=MANUAL-ECH
set treadle.0123456789abcd67.server=example.com
set treadle.0123456789abcd67.server_port=443
set treadle.0123456789abcd67.password=pw
set treadle.0123456789abcd67.tls_ech=1
set treadle.0123456789abcd68=node
set treadle.0123456789abcd68.type=hysteria2
set treadle.0123456789abcd68.tag=MANUAL-ECH-PEM
set treadle.0123456789abcd68.server=example.com
set treadle.0123456789abcd68.server_port=443
set treadle.0123456789abcd68.password=pw
set treadle.0123456789abcd68.tls_ech=1
set treadle.0123456789abcd6f=node
set treadle.0123456789abcd6f.type=urltest
set treadle.0123456789abcd6f.tag=MANUAL
set treadle.0123456789abcd6f.urltest_mode=manual
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-REALITY
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-TROJAN
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-XHTTP
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-ANYTLS
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-HY2
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-WS
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-SS
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-ECH
add_list treadle.0123456789abcd6f.urltest_outbounds=MANUAL-ECH-PEM
set treadle.routing.final_outbound=MANUAL
commit treadle
EOF
# A pasted ECH config is PEM text, newlines and all, as the editor's
# textarea stores it.
ECH_PEM=$(sing-box generate ech-keypair example.com | sed -n '/BEGIN ECH CONFIGS/,/END ECH CONFIGS/p')
uci set treadle.0123456789abcd68.tls_ech_config="$ECH_PEM"
# The same ECH node arriving through a subscription file.
uci set treadle.0123456789abcd69=subscription
uci set treadle.0123456789abcd69.name='ech fixture'
uci set treadle.0123456789abcd69.url=https://example.com/sub
uci set treadle.0123456789abcd69.enabled=1
uci add_list treadle.0123456789abcd6f.urltest_outbounds=SUB-ECH
uci commit treadle
printf '%s\n' '[{"type":"trojan","payload":"{\"type\":\"trojan\",\"tag\":\"SUB-ECH\",\"server\":\"example.com\",\"server_port\":443,\"password\":\"pw\",\"tls\":{\"enabled\":true,\"ech\":{\"enabled\":true}}}"}]' \
	> /etc/treadle/nodes/0123456789abcd69.json
build "advanced / manual nodes"
man="$OUT/advanced___manual_nodes.json"
mtls() { jsonfilter -i "$man" -e "@.outbounds[@.tag=\"$1\"].tls.$2"; }
[ "$(mtls MANUAL-REALITY reality.public_key)" = "$REALITY_PK" ] \
	&& [ "$(mtls MANUAL-REALITY reality.short_id)" = "0123abcd" ] \
	&& [ "$(mtls MANUAL-REALITY utls.fingerprint)" = "chrome" ] \
	&& ok "REALITY node carries its keys, with uTLS defaulted to chrome" \
	|| bad "REALITY node tls: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-REALITY"].tls')"
[ "$(mtls MANUAL-TROJAN 'alpn[*]' | tr '\n' ' ')" = "h2 http/1.1 " ] \
	&& ok "ALPN list reaches the node's tls block" \
	|| bad "ALPN: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-TROJAN"].tls')"
[ "$(mtls MANUAL-TROJAN min_version)" = 1.2 ] && [ "$(mtls MANUAL-TROJAN max_version)" = 1.3 ] \
	&& ok "TLS version bounds reach the tls block" \
	|| bad "TLS versions: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-TROJAN"].tls')"
if [ "$SB_ECH" = 1 ]; then
	[ "$(mtls MANUAL-ECH ech.enabled)" = true ] && [ -z "$(mtls MANUAL-ECH ech.config)" ] \
		&& [ "$(mtls SUB-ECH ech.enabled)" = true ] \
		&& ok "ECH (config from DNS) reaches manual and subscription nodes" \
		|| bad "ECH: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ECH"].tls')"
	[ "$(mtls MANUAL-ECH-PEM 'ech.config[*]' | wc -l)" -eq "$(printf '%s\n' "$ECH_PEM" | wc -l)" ] \
		&& ok "a pasted ECH config reaches the tls block line by line" \
		|| bad "ECH config: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ECH-PEM"].tls.ech')"
else
	[ -z "$(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ECH"].type')$(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ECH-PEM"].type')$(jsonfilter -i "$man" -e '@.outbounds[@.tag="SUB-ECH"].type')" ] \
		&& [ "$(grep -c "uses ECH, which this sing-box build cannot" "$OUT/build.log")" -eq 3 ] \
		&& ok "ECH nodes are skipped on a sing-box built without ECH" \
		|| { bad "ECH nodes on a build without ECH"; sed 's/^/    /' "$OUT/build.log"; }
fi
echo '{}' | "$HANDLER" call get_status > "$OUT/status-compat.json"
compat_n=$(jsonfilter -i "$OUT/status-compat.json" -e '@.compat[@.key="ech"].items[*]' | wc -l)
if [ "$SB_ECH" = 1 ]; then
	[ -z "$(jsonfilter -i "$OUT/status-compat.json" -e '@.compat')" ] \
		&& ok "get_status reports nothing left out for this sing-box" \
		|| bad "get_status compat: $(cat "$OUT/status-compat.json")"
else
	[ "$compat_n" -eq 3 ] && ok "get_status reports the 3 ECH nodes left out, for the Status warning" \
		|| bad "get_status compat: $(cat "$OUT/status-compat.json")"
fi
mtr() { jsonfilter -i "$man" -e "@.outbounds[@.tag=\"$1\"].transport.$2"; }
[ "$(mtr MANUAL-TROJAN type)" = httpupgrade ] && [ "$(mtr MANUAL-TROJAN path)" = /up ] \
	&& [ "$(mtr MANUAL-TROJAN host)" = example.org ] \
	&& ok "HTTPUpgrade transport is built with its path and host" \
	|| bad "HTTPUpgrade: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-TROJAN"].transport')"
referer=$(mtr MANUAL-XHTTP 'headers.Referer[0]')
[ "$(mtr MANUAL-XHTTP type)" = http ] && [ "$(mtr MANUAL-XHTTP method)" = POST ] \
	&& [ "$(mtr MANUAL-XHTTP path)" = /x ] && [ "$(mtr MANUAL-XHTTP 'host[0]')" = example.org ] \
	&& [ "${referer#https://example.org/?x_padding=x}" != "$referer" ] \
	&& [ -z "$(mtr MANUAL-XHTTP _xhttp)" ] \
	&& ok "XHTTP maps onto http with padding, host falling back to the SNI" \
	|| bad "XHTTP: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-XHTTP"].transport')"

# Share-link import: parse_node_link maps a link onto the editor's fields
# and names whatever the editor cannot hold.
[ -n "$(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ANYTLS"].type')" ] \
	&& [ -z "$(mtr MANUAL-ANYTLS type)" ] \
	&& ok "AnyTLS node is built without the transport sing-box rejects on it" \
	|| bad "AnyTLS: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-ANYTLS"]')"
mob() { jsonfilter -i "$man" -e "@.outbounds[@.tag=\"$1\"].$2"; }
[ "$(mob MANUAL-HY2 'server_ports[*]')" = 20000:30000 ] && [ "$(mob MANUAL-HY2 hop_interval)" = 1m ] \
	&& [ "$(mob MANUAL-HY2 up_mbps)" = 50 ] && [ "$(mob MANUAL-HY2 down_mbps)" = 200 ] \
	&& ok "Hysteria2 port hopping and bandwidth reach the node, the reversed range dropped" \
	|| bad "Hysteria2: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-HY2"]')"
[ "$(mtr MANUAL-WS max_early_data)" = 2048 ] \
	&& [ "$(mtr MANUAL-WS early_data_header_name)" = Sec-WebSocket-Protocol ] \
	&& ok "WebSocket early data reaches the transport" \
	|| bad "WS early data: $(jsonfilter -i "$man" -e '@.outbounds[@.tag="MANUAL-WS"].transport')"
[ "$(mob MANUAL-WS packet_encoding)" = packetaddr ] && [ "$(mob MANUAL-SS udp_over_tcp)" = true ] \
	&& ok "packet encoding and UDP over TCP reach their nodes" \
	|| bad "packet_encoding '$(mob MANUAL-WS packet_encoding)', udp_over_tcp '$(mob MANUAL-SS udp_over_tcp)'"

link() {
	printf '{"link":"%s"}' "$1" | "$HANDLER" call parse_node_link > "$OUT/link.json"
}
lf() { jsonfilter -i "$OUT/link.json" -e "@.fields.$1"; }
link "vless://00000000-0000-0000-0000-000000000000@example.com:443?security=reality&sni=example.org&fp=firefox&pbk=$REALITY_PK&sid=0123abcd&flow=xtls-rprx-vision&type=tcp#HK-01"
[ "$(lf type)" = vless ] && [ "$(lf tag)" = HK-01 ] && [ "$(lf server_port)" = 443 ] \
	&& [ "$(lf flow)" = xtls-rprx-vision ] && [ "$(lf tls_enabled)" = 1 ] \
	&& [ "$(lf tls_sni)" = example.org ] && [ "$(lf tls_fingerprint)" = firefox ] \
	&& [ "$(lf tls_reality)" = 1 ] && [ "$(lf tls_reality_public_key)" = "$REALITY_PK" ] \
	&& [ "$(lf tls_reality_short_id)" = 0123abcd ] \
	&& [ -z "$(jsonfilter -i "$OUT/link.json" -e '@.dropped[*]')" ] \
	&& ok "link import: VLESS REALITY link fills the editor fields" \
	|| bad "link import (REALITY): $(cat "$OUT/link.json")"
link "trojan://pw@example.com:443?type=ws&path=%2Fws&host=example.org&alpn=h2#NODE-01"
[ "$(lf transport_type)" = ws ] && [ "$(lf transport_ws_path)" = /ws ] \
	&& [ "$(lf transport_ws_host)" = example.org ] \
	&& [ "$(lf 'tls_alpn[0]')" = h2 ] \
	&& ok "link import: WebSocket link fills the transport and ALPN" \
	|| bad "link import (ws): $(cat "$OUT/link.json")"
link "vless://00000000-0000-0000-0000-000000000000@example.com:443?security=tls&type=httpupgrade&path=%2Fup&host=example.org#HK-01"
[ "$(lf transport_type)" = httpupgrade ] && [ "$(lf transport_httpupgrade_path)" = /up ] \
	&& [ "$(lf transport_httpupgrade_host)" = example.org ] \
	&& ok "link import: HTTPUpgrade link fills the transport" \
	|| bad "link import (httpupgrade): $(cat "$OUT/link.json")"
link "vless://00000000-0000-0000-0000-000000000000@example.com:443?security=tls&type=xhttp&mode=stream-one&path=%2Fx&host=example.org#HK-01"
[ "$(lf transport_type)" = xhttp ] && [ "$(lf transport_xhttp_path)" = /x ] \
	&& [ "$(lf transport_xhttp_host)" = example.org ] \
	&& ok "link import: XHTTP link fills the transport" \
	|| bad "link import (xhttp): $(cat "$OUT/link.json")"
link "hysteria2://pw@example.com:443?sni=example.org&mport=20000-30000&up=50&down=200#HK-01"
[ "$(lf 'hy2_server_ports[0]')" = 20000:30000 ] && [ "$(lf hy2_up_mbps)" = 50 ] \
	&& [ "$(lf hy2_down_mbps)" = 200 ] \
	&& ok "link import: Hysteria2 link fills port hopping and bandwidth" \
	|| bad "link import (hysteria2): $(cat "$OUT/link.json")"
link "not a link"
[ -n "$(jsonfilter -i "$OUT/link.json" -e '@.error')" ] \
	&& ok "link import: garbage is an error" || bad "link import (garbage): $(cat "$OUT/link.json")"

# Round trip (the behavioural half of scripts/check-node-fields.sh): every fixture
# share link goes through parse_node_link, becomes a manual node from the editor
# fields it returned, and is built; the result must equal the outbound the
# subscription path built from the same link. uri-rt.txt adds links that carry
# ALPN, uTLS, insecure, WebSocket, HTTP hosts, HTTPUpgrade, REALITY over gRPC,
# Hysteria2 obfuscation and hopping, and TUIC settings. XHTTP is left out: its
# padding is re-rolled on every build, so two builds never match.
cat > "$OUT/rt.lua" <<'EOF'
local j = require "luci.jsonc"
local function rd(p) local f = assert(io.open(p)); local s = f:read("*a"); f:close(); return j.parse(s) end
local function q(v) return "'" .. tostring(v):gsub("'", "'\\''") .. "'" end

if arg[1] == "uci" then
	local d, uid = rd(arg[2]), arg[3]
	local fields = d.fields or {}
	io.write("set treadle." .. uid .. "=node\n")
	local keys = {}
	for k in pairs(fields) do keys[#keys + 1] = k end
	table.sort(keys)
	for _, k in ipairs(keys) do
		local v = fields[k]
		if k == "tag" then v = "RT-" .. v end
		if type(v) == "table" then
			for _, x in ipairs(v) do io.write("add_list treadle." .. uid .. "." .. k .. "=" .. q(x) .. "\n") end
		else
			io.write("set treadle." .. uid .. "." .. k .. "=" .. q(v) .. "\n")
		end
	end
	for _, name in ipairs(d.dropped or {}) do io.stderr:write(name .. "\n") end
elseif arg[1] == "cmp" then
	local by = {}
	for _, ob in ipairs(rd(arg[2]).outbounds or {}) do by[ob.tag] = ob end
	local function diff(a, b, path, out)
		if type(a) ~= type(b) then out[#out + 1] = path .. ": " .. type(a) .. " vs " .. type(b); return end
		if type(a) == "table" then
			local keys = {}
			for k in pairs(a) do keys[k] = true end
			for k in pairs(b) do keys[k] = true end
			for k in pairs(keys) do diff(a[k], b[k], path .. "." .. tostring(k), out) end
		elseif a ~= b then
			out[#out + 1] = path .. ": " .. tostring(a) .. " vs " .. tostring(b)
		end
	end
	for i = 3, #arg do
		local tag = arg[i]
		local sub, man = by[tag], by["RT-" .. tag]
		if not sub then print(tag .. " MISSING subscription outbound")
		elseif not man then print(tag .. " MISSING round-tripped outbound")
		else
			sub, man = j.parse(j.stringify(sub)), j.parse(j.stringify(man))
			sub.tag, man.tag = nil, nil
			local out = {}
			diff(sub, man, "", out)
			table.sort(out)
			print(tag .. " " .. (#out == 0 and "equal" or "DIFF " .. table.concat(out, " | ")))
		end
	end
end
EOF
uci set treadle.0123456789abcd06=subscription
uci set treadle.0123456789abcd06.name="fixture uri-rt.txt"
uci set "treadle.0123456789abcd06.url=http://127.0.0.1:$PORT/uri-rt.txt"
uci set treadle.0123456789abcd06.enabled=1
uci commit treadle
printf '{"id":"0123456789abcd06"}' | "$HANDLER" call sync_subscription > "$OUT/sync-rt.json"
[ "$(jsonfilter -i "$OUT/sync-rt.json" -e '@.status')" = ok ] && [ "$(jsonfilter -i "$OUT/sync-rt.json" -e '@.node_count')" = 6 ] \
	&& ok "uri-rt.txt: 6 nodes" || bad "uri-rt.txt sync: $(cat "$OUT/sync-rt.json")"

rt_tags=""
n=0
rm -f "$OUT/rt.uci" "$OUT/rt.dropped"
for f in uri.txt uri-rt.txt; do
	while read -r line; do
		[ -n "$line" ] || continue
		n=$((n + 1))
		printf '{"link":"%s"}' "$line" | "$HANDLER" call parse_node_link > "$OUT/rt$n.json"
		rt_tag=$(jsonfilter -i "$OUT/rt$n.json" -e '@.fields.tag')
		rt_tags="$rt_tags $rt_tag"
		lua "$OUT/rt.lua" uci "$OUT/rt$n.json" "0123456789abce$(printf %02x "$n")" >> "$OUT/rt.uci" 2>> "$OUT/rt.dropped"
		# Both sides must reach the built config, so both join the manual group.
		echo "add_list treadle.0123456789abcd6f.urltest_outbounds=$rt_tag" >> "$OUT/rt.uci"
		echo "add_list treadle.0123456789abcd6f.urltest_outbounds=RT-$rt_tag" >> "$OUT/rt.uci"
	done < "$FIX/sub/$f"
done
# One node typed by hand: HTTP hosts as a comma-separated list, with stray spaces
# and an empty entry, the way the editor field takes them.
cat >> "$OUT/rt.uci" <<'EOF'
set treadle.0123456789abce40=node
set treadle.0123456789abce40.type=vless
set treadle.0123456789abce40.tag=RT-HAND
set treadle.0123456789abce40.server=example.com
set treadle.0123456789abce40.server_port=443
set treadle.0123456789abce40.uuid=00000000-0000-0000-0000-000000000000
set treadle.0123456789abce40.transport_type=http
set treadle.0123456789abce40.transport_http_host='a.example.org, b.example.org ,,c.example.org'
add_list treadle.0123456789abcd6f.urltest_outbounds=RT-HAND
EOF
echo "commit treadle" >> "$OUT/rt.uci"
uci batch < "$OUT/rt.uci"
build "round trip"
[ "$(jsonfilter -i "$OUT/round_trip.json" -e '@.outbounds[@.tag="RT-HAND"].transport.host[*]' | tr '\n' ' ')" \
	= "a.example.org b.example.org c.example.org " ] \
	&& ok "a hand-typed comma-separated HTTP host list becomes a trimmed host array" \
	|| bad "HTTP host list: $(jsonfilter -i "$OUT/round_trip.json" -e '@.outbounds[@.tag="RT-HAND"].transport')"
# shellcheck disable=SC2086
lua "$OUT/rt.lua" cmp "$OUT/round_trip.json" $rt_tags > "$OUT/rt.result"
while read -r tag verdict detail; do
	if [ "$verdict" = equal ]; then
		ok "round trip: $tag builds the same outbound from its link as the subscription does"
	else
		bad "round trip $tag: $verdict $detail"
	fi
done < "$OUT/rt.result"
[ ! -s "$OUT/rt.dropped" ] && ok "round trip: the editor holds every setting of the fixture links" \
	|| bad "round trip: settings the editor cannot hold: $(tr '\n' ' ' < "$OUT/rt.dropped")"

# Leave the config as it was: drop the round-trip nodes, their group entries and the subscription.
for t in $rt_tags; do
	uci del_list "treadle.0123456789abcd6f.urltest_outbounds=$t"
	uci del_list "treadle.0123456789abcd6f.urltest_outbounds=RT-$t"
done
n=1
while [ "$n" -le 20 ]; do uci -q delete "treadle.0123456789abce$(printf %02x "$n")"; n=$((n + 1)); done
uci del_list "treadle.0123456789abcd6f.urltest_outbounds=RT-HAND"
uci delete treadle.0123456789abce40
uci delete treadle.0123456789abcd06
uci commit treadle
rm -f /etc/treadle/nodes/0123456789abcd06.json

uci batch <<'EOF'
delete treadle.0123456789abcd60
delete treadle.0123456789abcd61
delete treadle.0123456789abcd62
delete treadle.0123456789abcd63
delete treadle.0123456789abcd64
delete treadle.0123456789abcd65
delete treadle.0123456789abcd66
delete treadle.0123456789abcd67
delete treadle.0123456789abcd68
delete treadle.0123456789abcd69
delete treadle.0123456789abcd6f
set treadle.routing.final_outbound=ALL
commit treadle
EOF
rm -f /etc/treadle/nodes/0123456789abcd69.json

# --- large subscription ------------------------------------------------------

step "large subscription"

# A regex group's candidate tags once reached grep on the command line, which
# `sh -c` receives as a single argument capped at 128 KiB: past a few thousand
# long tags popen failed and the group silently lost every member. 4000 tags
# of 45 bytes are ~190 KB quoted. The node file is written the way a sync
# stores it, for a subscription that is never actually fetched.
LARGE_N=4000
uci batch <<'EOF'
set treadle.0123456789abcd50=subscription
set treadle.0123456789abcd50.name=large fixture
set treadle.0123456789abcd50.url=https://example.com/sub
set treadle.0123456789abcd50.enabled=1
set treadle.0123456789abcd51=node
set treadle.0123456789abcd51.type=urltest
set treadle.0123456789abcd51.tag=LARGE
set treadle.0123456789abcd51.urltest_mode=regex
set treadle.0123456789abcd51.urltest_regex=^LARGE-TEST-
set treadle.routing.final_outbound=LARGE
commit treadle
EOF
awk -v n="$LARGE_N" 'BEGIN {
	printf "["
	for (i = 1; i <= n; i++)
		printf "%s{\"type\":\"socks\",\"payload\":\"{\\\"type\\\":\\\"socks\\\",\\\"tag\\\":\\\"LARGE-TEST-NODE-EXAMPLE-PADDING-PADDING-%05d\\\",\\\"server\\\":\\\"192.0.2.1\\\",\\\"server_port\\\":1080}\"}", (i > 1 ? "," : ""), i
	print "]"
}' > /etc/treadle/nodes/0123456789abcd50.json
build "advanced / large regex group"
members=$(jsonfilter -i "$OUT/advanced___large_regex_group.json" \
	-e '@.outbounds[@.tag="LARGE"].outbounds[*]' | wc -l)
[ "$members" -eq "$LARGE_N" ] && ok "regex group over $LARGE_N long tags has every member" \
	|| { bad "regex group LARGE has $members members, want $LARGE_N"; sed 's/^/    /' "$OUT/build.log"; }
uci batch <<'EOF'
delete treadle.0123456789abcd50
delete treadle.0123456789abcd51
set treadle.routing.final_outbound=ALL
commit treadle
EOF
rm -f /etc/treadle/nodes/0123456789abcd50.json

# --- sing-box version awareness ---------------------------------------------

step "sing-box version"

# How a remote rule-set's download is expressed depends on the installed
# sing-box: download_detour before 1.14, http_client from 1.14. "Default"
# (the shipped setting) goes through the default outbound, which from 1.14
# is named explicitly as the http_client detour.
rs_fields() {
	jsonfilter -i "$1" -e '@.route.rule_set[@.type="remote"]' \
		| sed -n 's/.*"\(download_detour\|http_client\)".*/\1/p' | sort -u | tr '\n' ' '
}
adv="$OUT/advanced___tproxy.json"
if [ "$SB_HTTP_CLIENT" = "1" ]; then
	d=$(jsonfilter -i "$adv" -e '@.route.rule_set[*].http_client.detour' | sort -u)
	[ "$d" = "ALL" ] && [ -z "$(jsonfilter -i "$adv" -e '@.route.rule_set[*].download_detour')" ] \
		&& ok "advanced rule-sets download via http_client through the default outbound" \
		|| bad "advanced rule-set download: detour '$d', fields: $(rs_fields "$adv")"
else
	[ -z "$(jsonfilter -i "$adv" -e '@.route.rule_set[*].download_detour')" ] \
		&& [ -z "$(jsonfilter -i "$adv" -e '@.route.rule_set[*].http_client')" ] \
		&& ok "advanced rule-sets download through the default outbound" \
		|| bad "advanced rule-set download fields: $(rs_fields "$adv")"
fi
[ -n "$(jsonfilter -i "$adv" -e '@.route.rule_set[*].tag')" ] \
	&& ok "advanced config has a remote rule-set" || bad "advanced config has no rule-set"

# From 1.14 every remote rule-set starts from an empty placeholder when
# nothing is cached, so startup never waits on (or dies of) a first download.
EMPTY=/var/etc/treadle/empty.srs
paths=$(jsonfilter -i "$adv" -e '@.route.rule_set[*].initial_path' | sort -u)
if [ "$SB_HTTP_CLIENT" = "1" ]; then
	[ "$paths" = "$EMPTY" ] && [ -s "$EMPTY" ] \
		&& ok "rule-sets start from the empty placeholder, and it was compiled" \
		|| bad "initial_path '$paths', placeholder $(ls -l "$EMPTY" 2>&1)"
else
	[ -z "$paths" ] && ok "no initial_path before sing-box 1.14" \
		|| bad "initial_path '$paths' emitted for $SB_VERSION"
fi

# The watchdog's flag flips the download route until the uptime it holds.
uci commit treadle
echo "$(( $(cut -d. -f1 /proc/uptime) + 600 ))" > /var/run/treadle.ruleset-flip
build "advanced / flipped download route"
echo 1 > /var/run/treadle.ruleset-flip
build "advanced / expired flip"
rm -f /var/run/treadle.ruleset-flip
for case in "flipped_download_route direct" "expired_flip default"; do
	f="$OUT/advanced___${case% *}.json"; want="${case#* }"
	if [ "$SB_HTTP_CLIENT" = "1" ]; then
		got=$(jsonfilter -i "$f" -e '@.route.rule_set[*].http_client.detour' | sort -u)
		[ "$got" = "ALL" ] && got=default
	else
		got=$(jsonfilter -i "$f" -e '@.route.rule_set[*].download_detour' | sort -u)
		[ -z "$got" ] && got=default
	fi
	[ "$got" = "$want" ] && ok "${case% *}: rule-sets download via $want" \
		|| bad "${case% *}: rule-sets download via '$got', want $want"
done
uci commit treadle

[ "$(cat "$adv.sbver" 2>/dev/null)" = "$SB_STAMP" ] \
	&& ok "build-config stamps the config with the sing-box version and Go release" \
	|| bad "stamp is '$(cat "$adv.sbver" 2>/dev/null)', want '$SB_STAMP'"

# `sing-box version` is cached under a key naming the binary (size, mtime).
# A hit must be used; a replaced binary (here: a new mtime) must miss.
VCACHE=/var/etc/treadle/.singbox-version-out
vkey=$(head -n 1 "$VCACHE" 2>/dev/null)
printf '%s\nsing-box version 9.9.9\n' "$vkey" > "$VCACHE"
"$BUILD" "$OUT/vcache.json" >/dev/null 2>&1
[ -n "$vkey" ] && [ "$(cat "$OUT/vcache.json.sbver")" = "sing-box version 9.9.9" ] \
	&& ok "build-config reads sing-box's version from its cache" \
	|| bad "version cache not used: key '$vkey', stamp '$(cat "$OUT/vcache.json.sbver" 2>/dev/null)'"
touch -d '2001-01-01 00:00:00' /usr/bin/sing-box
"$BUILD" "$OUT/vcache.json" >/dev/null 2>&1
[ "$(cat "$OUT/vcache.json.sbver")" = "$SB_STAMP" ] \
	&& ok "a replaced sing-box binary invalidates the version cache" \
	|| bad "stale version cache: stamp '$(cat "$OUT/vcache.json.sbver" 2>/dev/null)'"

# procd tags an instance's log lines with the basename of the command it
# started, so the wrapper has to be called sing-box or every sing-box line
# drops out of the Status log view and `logread -e sing-box`.
run_sb=$(sed -n 's/^RUN_SINGBOX=//p' /etc/init.d/treadle)
[ "$(basename "$run_sb")" = "sing-box" ] && [ -x "$run_sb" ] \
	&& ok "procd starts sing-box through a wrapper named sing-box" \
	|| bad "procd command is '$run_sb'; its basename must be sing-box"

# The start wrapper rebuilds a config whose stamp differs from the installed
# sing-box: another version, or the same version built with another Go (which
# flips the ech capability). Mixed mode needs no tproxy privileges, so
# sing-box can actually start here; it is stopped once the stamp has been checked.
uci set treadle.inbounds.mode=mixed
uci commit treadle
wrap="$OUT/wrap.json"
"$BUILD" "$wrap" >/dev/null 2>&1
for stale in "sing-box version 0.0.0" "$SB_VERSION go0.0"; do
	echo "$stale" > "$wrap.sbver"
	/usr/libexec/treadle/sing-box "$wrap" > "$OUT/wrap.log" 2>&1 &
	WRAP=$!
	i=0
	while [ "$i" -lt 20 ] && [ "$(cat "$wrap.sbver" 2>/dev/null)" != "$SB_STAMP" ]; do
		sleep 1; i=$((i + 1))
	done
	kill "$WRAP" 2>/dev/null; wait "$WRAP" 2>/dev/null
	[ "$(cat "$wrap.sbver" 2>/dev/null)" = "$SB_STAMP" ] && [ ! -e "$wrap.next" ] \
		&& [ -s /var/run/treadle.started ] \
		&& ok "the start wrapper rebuilds a config stamped '$stale' and records its start time" \
		|| { bad "the start wrapper left stamp '$(cat "$wrap.sbver" 2>/dev/null)' for '$stale'"; sed 's/^/    /' "$OUT/wrap.log"; }
done
uci set treadle.inbounds.mode=tproxy
uci commit treadle

# --- rule-set cache warm-up -------------------------------------------------

# sing-box 1.12/1.13 exit when a remote rule-set that is not cached fails to
# download at startup, and the shipped route (through the default urltest,
# whose first member is a placeholder here) fails that way. A rules-only
# sing-box downloads over the WAN into the real cache file first, so the real
# start finds them cached (0144). The rule-set is a local HTTP file, so this
# needs no outside network. From 1.14 an empty placeholder already prevents
# the exit, so the cold start is only a failure before that.
step "rule-set cache warm-up"
RSD="$OUT/warm"
mkdir -p "$RSD/www"
echo '{"version":1,"rules":[{"domain_suffix":["warm.invalid"]}]}' > "$RSD/t.json"
sing-box rule-set compile -o "$RSD/www/t.srs" "$RSD/t.json" >/dev/null 2>&1 \
	|| die "could not compile the test rule-set"
uhttpd -f -p 127.0.0.1:18200 -h "$RSD/www" >/dev/null 2>&1 &
WARM_HTTP=$!
uci batch <<'EOF'
set treadle.0123456789abcd40.enabled=0
set treadle.0123456789abcd60=customrs
set treadle.0123456789abcd60.label=warmtest
set treadle.0123456789abcd60.url=http://127.0.0.1:18200/t.srs
set treadle.0123456789abcd60.format=binary
set treadle.0123456789abcd61=rule
set treadle.0123456789abcd61.enabled=1
set treadle.0123456789abcd61.order=3
set treadle.0123456789abcd61.outbound=direct
set treadle.0123456789abcd62=condition
set treadle.0123456789abcd62.rule=0123456789abcd61
set treadle.0123456789abcd62.kind=ruleset
add_list treadle.0123456789abcd62.value=warmtest
commit treadle
EOF
build "warm real"
real="$OUT/warm_real.json"
"$BUILD" --bootstrap "$RSD/boot.json" >/dev/null 2>&1
[ -f "$RSD/boot.json" ] && sing-box check -c "$RSD/boot.json" >/dev/null 2>&1 \
	&& ok "the warm-up config exists and passes sing-box check" \
	|| bad "no valid warm-up config for a via-proxy rule-set download"
want_tag=$(jsonfilter -i "$real" -e '@.route.rule_set[@.type="remote"].tag')
got_tag=$(jsonfilter -i "$RSD/boot.json" -e '@.route.rule_set[*].tag')
[ -n "$want_tag" ] && [ "$got_tag" = "$want_tag" ] \
	&& ok "the warm-up uses the real rule-set tag, so the cache key matches" \
	|| bad "warm-up rule-set '$got_tag', real '$want_tag'"
if [ "$SB_HTTP_CLIENT" = "1" ]; then
	via=$(jsonfilter -i "$RSD/boot.json" -e '@.route.rule_set[*].http_client.detour')
else
	via=$(jsonfilter -i "$RSD/boot.json" -e '@.route.rule_set[*].download_detour')
fi
[ "$via" = "direct" ] && ok "the warm-up downloads direct" || bad "warm-up download route '$via'"
[ "$(jsonfilter -i "$RSD/boot.json" -e '@.experimental.cache_file.path')" \
	= "$(jsonfilter -i "$real" -e '@.experimental.cache_file.path')" ] \
	&& ok "the warm-up writes the real cache file" || bad "warm-up cache file differs"

uci set treadle.global.ruleset_download_detour=direct
uci commit treadle
rm -f "$RSD/boot.json"
"$BUILD" --bootstrap "$RSD/boot.json" >/dev/null 2>&1
[ ! -e "$RSD/boot.json" ] && ok "nothing to warm when rule-sets already download direct" \
	|| bad "a warm-up config was written for a direct download route"
uci delete treadle.global.ruleset_download_detour
uci commit treadle

# The real config with its tun/tproxy inbound swapped for a plain listener, so
# sing-box can run unprivileged here.
cat > "$RSD/runnable.lua" <<'EOF'
local j = require "luci.jsonc"
local f = io.open(arg[1]); local c = j.parse(f:read("*a")); f:close()
local keep = {}
for _, ib in ipairs(c.inbounds or {}) do
	if ib.type ~= "tun" and ib.type ~= "tproxy" then keep[#keep + 1] = ib end
end
keep[#keep + 1] = { type = "mixed", tag = "warm-in", listen = "127.0.0.1", listen_port = 18210 }
c.inbounds = keep
c.log = { level = "info", timestamp = false }   -- the started line is the signal
local o = io.open(arg[2], "w"); o:write((j.stringify(c, true):gsub("\\/", "/"))); o:close()
EOF
lua "$RSD/runnable.lua" "$real" "$RSD/real-run.json"
sing-box check -c "$RSD/real-run.json" >/dev/null 2>&1 || die "the runnable test config is invalid"

# start the real-style config; report started / FATAL (max 25 s)
warm_start() {
	sing-box run -c "$RSD/real-run.json" > "$RSD/run.log" 2>&1 &
	wp=$!
	n=0; res=timeout
	while [ "$n" -lt 25 ]; do
		grep -q "sing-box started" "$RSD/run.log" && { res=started; break; }
		grep -q "FATAL" "$RSD/run.log" && { res=FATAL; break; }
		n=$((n + 1)); sleep 1
	done
	kill "$wp" 2>/dev/null; wait "$wp" 2>/dev/null
	echo "$res"
}
rm -f /etc/treadle/cache.db
cold=$(warm_start)
if [ "$SB_HTTP_CLIENT" = "1" ]; then
	[ "$cold" = "started" ] && ok "cold cache, dead download route: 1.14 starts on the empty placeholder" \
		|| bad "cold start on 1.14 gave '$cold'"
else
	[ "$cold" = "FATAL" ] && ok "cold cache, dead download route: sing-box exits (the failure the warm-up prevents)" \
		|| bad "cold start gave '$cold', expected the rule-set FATAL before 1.14"
fi

# The init script's function, run on its own with its three inputs stubbed.
sed -n '/^treadle_warm_rule_sets() {/,/^}/p' /etc/init.d/treadle > "$RSD/warm-fn.sh"
rm -f /etc/treadle/cache.db "$RSD/log"
(
	# Exported only because the sourced function reads them.
	export BUILD_CONFIG="$BUILD" SINGBOX=/usr/bin/sing-box config_path=/nonexistent/sing-box.json
	treadle_log() { echo "$1 $2" >> "$RSD/log"; }
	# shellcheck disable=SC1091
	. "$RSD/warm-fn.sh"
	treadle_warm_rule_sets
)
grep -q "cache warmed before start" "$RSD/log" 2>/dev/null && [ -s /etc/treadle/cache.db ] \
	&& ok "the warm-up downloaded the rule-set into the cache" \
	|| bad "warm-up did not warm the cache: $(cat "$RSD/log" 2>/dev/null)"
[ ! -e /var/etc/treadle/sing-box-bootstrap.json ] && [ ! -e /var/etc/treadle/sing-box-bootstrap.log ] \
	&& ok "the warm-up leaves no files behind" || bad "warm-up left its config or log behind"
warm=$(warm_start)
[ "$warm" = "started" ] && ok "after the warm-up the real start succeeds with the download route still dead" \
	|| bad "warm start gave '$warm': $(tail -c 400 "$RSD/run.log" | sed 's/\x1b\[[0-9;]*m//g')"

kill "$WARM_HTTP" 2>/dev/null; wait "$WARM_HTTP" 2>/dev/null
rm -f /etc/treadle/cache.db
uci batch <<'EOF'
delete treadle.0123456789abcd60
delete treadle.0123456789abcd61
delete treadle.0123456789abcd62
set treadle.0123456789abcd40.enabled=1
commit treadle
EOF

# --- connect timeout --------------------------------------------------------

# sing-box already bounds a dial at 5 s, so nothing is stamped unless the user
# sets a different limit (decision 0142). Proxy outbounds carry it, groups and
# direct do not.
step "connect timeout"
uci delete treadle.global.connect_timeout 2>/dev/null
uci commit treadle
ct_fields() { jsonfilter -i "$1" -e '@.outbounds[*].connect_timeout' | sort -u | tr '\n' ' '; }
ct_proxies() { jsonfilter -i "$1" -e '@.outbounds[@.server].tag' | wc -l; }
ct_stamped() { jsonfilter -i "$1" -e '@.outbounds[@.connect_timeout].tag' | wc -l; }
build "connect timeout unset"
[ -z "$(ct_fields "$OUT/connect_timeout_unset.json")" ] && [ "$(ct_proxies "$OUT/connect_timeout_unset.json")" -gt 0 ] \
	&& ok "no connect_timeout is stamped by default" \
	|| bad "default config stamps '$(ct_fields "$OUT/connect_timeout_unset.json")'"
for v in 5s 0 0s; do
	uci set treadle.global.connect_timeout="$v"
	uci commit treadle
	build "connect timeout $v"
	f="$OUT/connect_timeout_$v.json"
	[ -z "$(ct_fields "$f")" ] && ok "connect_timeout '$v' stamps nothing (sing-box's own 5 s applies)" \
		|| bad "connect_timeout '$v' stamps '$(ct_fields "$f")'"
done
uci set treadle.global.connect_timeout=bogus
uci commit treadle
build "connect timeout bogus"
f="$OUT/connect_timeout_bogus.json"
[ -z "$(ct_fields "$f")" ] && grep -q "connect_timeout 'bogus' is not a duration" "$OUT/build.log" \
	&& ok "a malformed connect_timeout is dropped with a warning" \
	|| bad "malformed connect_timeout: stamps '$(ct_fields "$f")', log: $(head -c 200 "$OUT/build.log")"
uci set treadle.global.connect_timeout=8s
uci commit treadle
build "connect timeout 8s"
f="$OUT/connect_timeout_8s.json"
[ "$(ct_fields "$f")" = "8s " ] && [ "$(ct_stamped "$f")" = "$(ct_proxies "$f")" ] \
	&& ok "connect_timeout 8s is stamped on every proxy outbound, and only those" \
	|| bad "connect_timeout 8s: fields '$(ct_fields "$f")', stamped $(ct_stamped "$f") of $(ct_proxies "$f") proxies"
uci delete treadle.global.connect_timeout
uci commit treadle

# Fake-IP keeps the per-server cache flag only where it does something
# (before 1.14); the optimistic cache is emitted from 1.14, with a valid
# window passed through and a malformed one dropped for sing-box's default.
dns_field() { jsonfilter -i "$OUT/$1.json" -e "@.dns.$2"; }
uci set treadle.dns.fakeip_enabled=1
uci set treadle.dns.optimistic=1
uci set treadle.dns.optimistic_timeout=12h
uci commit treadle
build "dns fakeip optimistic"
indep=$(dns_field dns_fakeip_optimistic independent_cache)
opt=$(dns_field dns_fakeip_optimistic optimistic.timeout)
if [ "$SB_114" = 1 ]; then
	[ -z "$indep" ] && ok "no independent_cache from sing-box 1.14" \
		|| bad "independent_cache '$indep' emitted for $SB_VERSION"
	[ "$opt" = "12h" ] && [ "$(dns_field dns_fakeip_optimistic optimistic.enabled)" = "true" ] \
		&& ok "optimistic DNS cache with its window" \
		|| bad "optimistic: $(jsonfilter -i "$OUT/dns_fakeip_optimistic.json" -e '@.dns.optimistic')"
else
	[ "$indep" = "true" ] && ok "fake-IP keeps independent_cache before sing-box 1.14" \
		|| bad "independent_cache is '$indep' for $SB_VERSION, want true"
	[ -z "$(jsonfilter -i "$OUT/dns_fakeip_optimistic.json" -e '@.dns.optimistic')" ] \
		&& grep -q "optimistic DNS cache needs sing-box 1.14" "$OUT/build.log" \
		&& ok "no optimistic DNS cache before sing-box 1.14" \
		|| bad "optimistic on $SB_VERSION, log: $(head -c 200 "$OUT/build.log")"
fi
if [ "$SB_114" = 1 ]; then
	uci set treadle.dns.optimistic_timeout=bogus
	uci commit treadle
	build "dns optimistic bogus window"
	[ "$(dns_field dns_optimistic_bogus_window optimistic)" = "true" ] \
		&& grep -q "optimistic_timeout 'bogus' is not a duration" "$OUT/build.log" \
		&& ok "a malformed optimistic window falls back to sing-box's default" \
		|| bad "optimistic bogus window: $(jsonfilter -i "$OUT/dns_optimistic_bogus_window.json" -e '@.dns.optimistic')"
fi
uci set treadle.dns.fakeip_enabled=0
uci set treadle.dns.optimistic=0
uci delete treadle.dns.optimistic_timeout
uci commit treadle

# --- failover nudge ---------------------------------------------------------

# A urltest group keeps sending connections to a dead active member until its
# next scheduled test pass. active-watch nudges the group as soon as that
# member loses its result, so the switch happens within a poll, not an
# interval. The group here tests only every 300 s: moving off the dead member
# within seconds can only be the nudge. Two loopback SOCKS servers are the
# members; the clash API is on 9090, where active-watch looks for it.
step "failover nudge"
if ! command -v curl >/dev/null 2>&1; then
	if command -v apk >/dev/null 2>&1; then apk add curl >/dev/null 2>&1; else opkg install curl >/dev/null 2>&1; fi
fi
FO="$OUT/fo"
mkdir -p "$FO/www"
echo ok > "$FO/www/index.html"
for n in 1 2; do
	cat > "$FO/s$n.json" <<EOF
{ "log": { "level": "warn" },
  "inbounds": [ { "type": "socks", "tag": "in", "listen": "127.0.0.1", "listen_port": 1810$n } ],
  "outbounds": [ { "type": "direct", "tag": "direct" } ],
  "route": { "final": "direct" } }
EOF
done
cat > "$FO/t.json" <<EOF
{ "log": { "level": "warn" },
  "inbounds": [ { "type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": 18100 } ],
  "outbounds": [
    { "type": "socks", "tag": "m1", "server": "127.0.0.1", "server_port": 18101, "version": "5" },
    { "type": "socks", "tag": "m2", "server": "127.0.0.1", "server_port": 18102, "version": "5" },
    { "type": "socks", "tag": "solo", "server": "127.0.0.1", "server_port": 18101, "version": "5" },
    { "type": "urltest", "tag": "g", "outbounds": [ "m1", "m2" ],
      "url": "http://127.0.0.1:18199/", "interval": "300s", "tolerance": 50 } ],
  "route": { "final": "g" },
  "experimental": { "clash_api": { "external_controller": "127.0.0.1:9090" } } }
EOF
fo_now() { uclient-fetch -qO- http://127.0.0.1:9090/proxies/g 2>/dev/null | sed -n 's/.*"now": *"\([^"]*\)".*/\1/p'; }
fo_probe() { curl -s -m 12 -o /dev/null -x socks5h://127.0.0.1:18100 http://127.0.0.1:18199/; }
if command -v curl >/dev/null 2>&1; then
	uhttpd -f -p 127.0.0.1:18199 -h "$FO/www" >/dev/null 2>&1 &
	FO_PIDS="$!"
	sing-box run -c "$FO/s1.json" >"$FO/s1.log" 2>&1 &
	FO_S1=$!
	sing-box run -c "$FO/s2.json" >"$FO/s2.log" 2>&1 &
	FO_S2=$!
	FO_PIDS="$FO_PIDS $FO_S1 $FO_S2"
	# Both servers must answer before the group starts: a member whose first test
	# fails because its server is not listening yet loses its result, and the group
	# then settles on the other one for the whole (300 s) interval.
	fo_up() { curl -s -m 3 -o /dev/null -x "socks5h://127.0.0.1:$1" http://127.0.0.1:18199/; }
	i=0
	while [ "$i" -lt 30 ] && ! { fo_up 18101 && fo_up 18102; }; do sleep 1; i=$((i + 1)); done
	sing-box run -c "$FO/t.json" >"$FO/t.log" 2>&1 &
	FO_PIDS="$FO_PIDS $!"
	# The group as the default node and a rule's single node, for the probe pass.
	fo_final=$(uci -q get treadle.routing.final_outbound)
	uci set treadle.global.clash_api_enabled=1
	uci set treadle.routing.final_outbound=g
	uci set treadle.0123456789abcd70=rule
	uci set treadle.0123456789abcd70.enabled=1
	uci set treadle.0123456789abcd70.outbound=solo
	uci commit treadle
	TREADLE_PROBE_URL=http://127.0.0.1:18199/ lua /usr/libexec/treadle/active-watch >"$FO/aw.log" 2>&1 &
	FO_PIDS="$FO_PIDS $!"
	i=0
	while [ "$i" -lt 30 ] && [ -z "$(fo_now)" ]; do sleep 1; i=$((i + 1)); done
	# Whichever member the group picked first is the one that dies.
	first=$(fo_now)
	case "$first" in
		m1) victim=$FO_S1; other=m2 ;;
		m2) victim=$FO_S2; other=m1 ;;
		*)  victim=; other= ;;
	esac
	fo_probe && [ -n "$victim" ] \
		&& ok "the test group is serving through its first member" \
		|| bad "test group: now='$first', probe failed: $(head -c 300 "$FO/t.log")"
	# The probe pass (second tick): each group's members, the rule's single
	# node tested on its own, and the connectivity check through the node
	# the default group is using.
	ACT=/var/etc/treadle/.active-nodes.json
	i=0
	while [ "$i" -lt 30 ] && [ -z "$(jsonfilter -i "$ACT" -e '@.connectivity.state' 2>/dev/null)" ]; do
		sleep 1; i=$((i + 1))
	done
	[ "$(jsonfilter -i "$ACT" -e '@.groups.g.members[*].tag' 2>/dev/null | tr '\n' ' ')" = "m1 m2 " ] \
		&& ok "active-watch records every member of a group" \
		|| bad "group members: $(jsonfilter -i "$ACT" -e '@.groups.g' 2>&1 | head -c 300)"
	[ -n "$(jsonfilter -i "$ACT" -e '@.nodes.solo.delay_ms' 2>/dev/null)" ] \
		&& ok "a node a rule uses on its own gets a latency from the probe pass" \
		|| bad "single node: $(jsonfilter -i "$ACT" -e '@.nodes' 2>&1 | head -c 300)"
	[ "$(jsonfilter -i "$ACT" -e '@.connectivity.state' 2>/dev/null)" = ok ] \
		&& [ "$(jsonfilter -i "$ACT" -e '@.connectivity.via' 2>/dev/null)" = "$first" ] \
		&& ok "the connectivity check passes through the default group's current node" \
		|| bad "connectivity: $(jsonfilter -i "$ACT" -e '@.connectivity' 2>&1 | head -c 300)"
	echo '{}' | "$HANDLER" call get_active_groups > "$OUT/groups.json"
	[ "$(jsonfilter -i "$OUT/groups.json" -e '@.nodes[0].tag')" = solo ] \
		&& [ -n "$(jsonfilter -i "$OUT/groups.json" -e '@.connectivity.state')" ] \
		&& [ -n "$(jsonfilter -i "$OUT/groups.json" -e '@.now')" ] \
		&& ok "get_active_groups passes the probe results and the router's clock to the page" \
		|| bad "get_active_groups: $(head -c 300 "$OUT/groups.json")"
	[ -n "$victim" ] && { kill "$victim" 2>/dev/null; wait "$victim" 2>/dev/null; }
	fo_probe    # the failed request that makes sing-box drop the member's result
	i=0
	while [ "$i" -lt 40 ]; do
		[ -n "$other" ] && [ "$(fo_now)" = "$other" ] && fo_probe && break
		sleep 1; i=$((i + 1))
	done
	[ "$i" -lt 40 ] && ok "active-watch moved the group from $first to $other within ${i}s (interval 300s)" \
		|| bad "group still on '$(fo_now)' after 40s with its active member ($first) dead"
	# Traffic stats: /connections every tick (10 s) while the Status page
	# polls (get_clash_stats stamps a marker), once a minute otherwise.
	aw_ts() { jsonfilter -i "$1" -e '@.updated_at' 2>/dev/null; }
	STS=/var/etc/treadle/.clash-stats.json
	# Two stats writes within 25 s while watched: only the per-tick path does that.
	n=0; last=$(aw_ts "$STS"); i=0
	while [ "$i" -lt 25 ] && [ "$n" -lt 2 ]; do
		echo '{}' | "$HANDLER" call get_clash_stats >/dev/null
		sleep 1; i=$((i + 1))
		cur=$(aw_ts "$STS")
		[ -n "$cur" ] && [ "$cur" != "$last" ] && { n=$((n + 1)); last=$cur; }
	done
	[ "$n" -ge 2 ] && ok "active-watch fetches /connections every tick while the Status page is open" \
		|| bad "stats written $n time(s) in 25s while watched"
	# Unwatched: two more ticks of the groups snapshot, no new stats write.
	rm -f /var/etc/treadle/.status-viewed
	idle_from=$(aw_ts "$STS"); ticks=0; prev=$(aw_ts "$ACT"); i=0
	while [ "$i" -lt 30 ] && [ "$ticks" -lt 2 ]; do
		sleep 1; i=$((i + 1))
		cur=$(aw_ts "$ACT")
		[ -n "$cur" ] && [ "$cur" != "$prev" ] && { ticks=$((ticks + 1)); prev=$cur; }
	done
	[ "$ticks" -ge 2 ] && [ "$(aw_ts "$STS")" = "$idle_from" ] \
		&& ok "active-watch skips /connections while nobody is watching" \
		|| bad "idle: $ticks tick(s), stats $idle_from -> $(aw_ts "$STS")"
	for p in $FO_PIDS; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
	uci set treadle.global.clash_api_enabled=0
	uci set treadle.routing.final_outbound="$fo_final"
	uci delete treadle.0123456789abcd70
	uci commit treadle
else
	bad "curl is not available for the failover test"
fi

# --- sing-box updates from SagerNet ------------------------------------------
# The check reads a recorded releases/latest reply (no GitHub call, no rate
# limit); the install and revert paths need the real packages and are tested
# by hand on 25.12 and 24.10 (decision 0153).

step "sing-box updates"
SBU=/usr/libexec/treadle/singbox-update
SBU_STATUS=/var/etc/treadle/singbox-update.json
if command -v apk >/dev/null 2>&1; then sbu_ext=apk; else sbu_ext=ipk; fi
sbu_arch=$(cat /etc/apk/arch 2>/dev/null || opkg print-architecture | awk '$2 != "all" && $2 != "noarch" {print $2}' | tail -n 1)

TREADLE_SBU_LATEST_JSON="$FIX/singbox-release-latest.json" "$SBU" check
echo '{}' | "$HANDLER" call get_singbox_update > "$OUT/sbu.json"
sbu() { jsonfilter -i "$OUT/sbu.json" -e "$1"; }
[ "$(sbu '@.state')" = checked ] && [ "$(sbu '@.newer')" = true ] \
	&& [ "$(sbu '@.latest.version')" = 9.9.9 ] \
	&& ok "check finds the newer stable release" \
	|| bad "check: $(cat "$OUT/sbu.json")"
[ "$(sbu '@.latest.asset.name')" = "sing-box_9.9.9_openwrt_${sbu_arch}.${sbu_ext}" ] \
	&& [ -n "$(sbu '@.latest.asset.sha256')" ] \
	&& ok "check picks this router's $sbu_ext for $sbu_arch, with its SHA-256" \
	|| bad "check picked '$(sbu '@.latest.asset.name')' for $sbu_arch/$sbu_ext"
[ "$(sbu '@.current.source')" = openwrt ] && [ -n "$(sbu '@.current.version')" ] \
	&& ok "get_singbox_update reports the installed OpenWrt sing-box" \
	|| bad "current: $(sbu '@.current')"

sed 's/"prerelease": false/"prerelease": true/' "$FIX/singbox-release-latest.json" > "$OUT/sbu-pre.json"
TREADLE_SBU_LATEST_JSON="$OUT/sbu-pre.json" "$SBU" check
[ "$(jsonfilter -i "$SBU_STATUS" -e '@.state')" = error ] \
	&& ok "check refuses a pre-release" || bad "check accepted a pre-release"

echo '{"version":"1.2.3;reboot"}' | "$HANDLER" call install_singbox_update > "$OUT/sbu-bad.json"
[ "$(jsonfilter -i "$OUT/sbu-bad.json" -e '@.error')" = "invalid version" ] \
	&& ok "install rejects a malformed version" || bad "install_singbox_update: $(cat "$OUT/sbu-bad.json")"

# get_status flags the sing-box package's own service when it is enabled.
uci -q set sing-box.main.enabled=1 && uci commit sing-box
echo '{}' | "$HANDLER" call get_status > "$OUT/status-sa.json"
[ "$(jsonfilter -i "$OUT/status-sa.json" -e '@.standalone_singbox')" = true ] \
	&& ok "get_status flags the standalone sing-box service" \
	|| bad "standalone_singbox not set: $(cat "$OUT/status-sa.json")"
uci -q set sing-box.main.enabled=0 && uci commit sing-box

# --- Basic mode migration ---------------------------------------------------

# Basic mode was removed; migrate-basic rewrites its settings as ordinary
# sections so the running behaviour does not change. Rules Basic ignored are
# disabled, a non-empty extra.json is moved aside, and a second run is a no-op.
step "basic migration"
MIG=/usr/libexec/treadle/migrate-basic
printf '{ "log": { "level": "debug" } }\n' > /etc/treadle/extra.json
uci batch <<'EOF'
set treadle.global.mode=basic
set treadle.basic=treadle
add_list treadle.basic.server=HK-05
add_list treadle.basic.server=SG-01
add_list treadle.basic.server=GONE-01
set treadle.basic.routing=bypass_country
set treadle.basic.bypass_country=cn
set treadle.basic.ports=common
commit treadle
EOF
"$MIG"
[ -z "$(uci -q get treadle.global.mode)" ] && [ -z "$(uci -q get treadle.basic)" ] \
	&& ok "migration removes the mode flag and the basic section" \
	|| bad "after migration: mode '$(uci -q get treadle.global.mode)', basic '$(uci -q get treadle.basic)'"
sec_by() { uci show treadle | sed -n "s/^treadle\.\([0-9a-f]*\)\.$1='$2'\$/\1/p"; }
grp=$(sec_by tag Auto)
[ -n "$grp" ] && [ "$(uci -q get "treadle.$grp.type")" = urltest ] \
	&& [ "$(uci -q get "treadle.$grp.urltest_outbounds")" = "HK-05 SG-01" ] \
	&& ok "several servers become an Auto urltest group, missing ones dropped" \
	|| bad "Auto group '$grp': $(uci -q show "treadle.$grp")"
r_cc=$(sec_by name 'Bypass CN'); r_pt=$(sec_by name 'Common ports')
c_cc=$(sec_by rule "$r_cc"); c_pt=$(sec_by rule "$r_pt")
[ "$(uci -q get "treadle.$r_cc.order")" = 0 ] && [ "$(uci -q get "treadle.$r_cc.outbound")" = direct ] \
	&& [ "$(uci -q get "treadle.$c_cc.value")" = "sagernet/geoip-cn sagernet/geosite-cn" ] \
	&& ok "country bypass becomes the first rule, geoip and geosite to direct" \
	|| bad "bypass rule: $(uci -q show "treadle.$r_cc") $(uci -q show "treadle.$c_cc")"
[ "$(uci -q get "treadle.$r_pt.order")" = 1 ] && [ "$(uci -q get "treadle.$r_pt.outbound")" = Auto ] \
	&& [ "$(uci -q get "treadle.$c_pt.kind")" = port ] \
	&& [ "$(uci -q get treadle.routing.final_outbound)" = direct ] \
	&& ok "common ports become a port rule to the group, with a direct final" \
	|| bad "ports rule: $(uci -q show "treadle.$r_pt"), final '$(uci -q get treadle.routing.final_outbound)'"
[ "$(uci -q get treadle.0123456789abcd20.enabled)" = 0 ] \
	&& [ "$(uci -q get treadle.0123456789abcd40.enabled)" = 0 ] \
	&& [ "$(uci -q get treadle.0123456789abcd20.order)" = 3 ] \
	&& ok "rules Basic ignored are disabled and moved after the migrated ones" \
	|| bad "old rules: $(uci -q show treadle.0123456789abcd20)"
[ "$(uci -q get treadle.inbounds.tproxy_self)" = 0 ] \
	&& ok "router traffic stays direct, as in Basic" \
	|| bad "tproxy_self is '$(uci -q get treadle.inbounds.tproxy_self)', want 0"
grep -q debug /etc/treadle/extra.json.pre-migration 2>/dev/null \
	&& [ "$(tr -d ' \n' < /etc/treadle/extra.json)" = "{}" ] \
	&& ok "a non-empty extra.json is moved aside" \
	|| bad "extra.json not moved aside: $(cat /etc/treadle/extra.json)"
build "migrated basic"
mb="$OUT/migrated_basic.json"
[ "$(jsonfilter -i "$mb" -e '@.route.rules[@.port].outbound')" = Auto ] \
	&& [ "$(jsonfilter -i "$mb" -e '@.route.final')" = direct ] \
	&& [ "$(jsonfilter -i "$mb" -e '@.route.rules[@.rule_set[0]="sagernet-geoip-cn"].outbound')" = direct ] \
	&& ok "the migrated config routes as Basic did" \
	|| bad "migrated route: $(jsonfilter -i "$mb" -e '@.route.rules[*]' | tr '\n' ' ')"
before=$(uci export treadle | md5sum)
"$MIG"
[ "$(uci export treadle | md5sum)" = "$before" ] \
	&& ok "a second migration run changes nothing" \
	|| bad "a second migration run changed the config"
# An Advanced config only loses the two leftovers.
uci set treadle.global.mode=advanced
uci set treadle.basic=treadle
uci set treadle.basic.routing=all
uci commit treadle
"$MIG"
[ -z "$(uci -q get treadle.global.mode)" ] && [ -z "$(uci -q get treadle.basic)" ] \
	&& [ "$(uci export treadle | md5sum)" = "$before" ] \
	&& ok "an Advanced config only loses the mode flag and the basic section" \
	|| bad "advanced migration changed more than the leftovers"
rm -f /etc/treadle/extra.json.pre-migration

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
