#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Treadle firewall integration for TPROXY inbound.
#
# Installs an `inet treadle` nftables table with a mangle-prerouting chain
# that TPROXYs transit LAN TCP+UDP to sing-box's tproxy listener, plus
# the matching policy-routing rule + table that delivers marked packets
# to the loopback socket. Only active when `inbounds.mode` is `tproxy`
# or `tproxy_mixed`; tun mode needs no firewall (sing-box handles routing).
#
# When inbounds.tproxy_self is enabled (the default), a `route`-hook
# OUTPUT chain also marks router-originated traffic so the same policy
# routing loops it back through PREROUTING for TPROXY pickup. sing-box's
# own outbound packets are skipped via route.default_mark=255 (set by
# build-config), which appears here as SELF_MARK.
#
# When dns.fakeip_enabled is set, the configured fake-IP ranges are
# TPROXY'd explicitly. Those ranges fall inside the reserved-range bypass
# below, so without this carve-out fake-IP traffic would be accepted as
# "reserved", sent direct, and never reach sing-box for demapping.

MARK=0x1
SELF_MARK=0xff
TABLE=100
NFT_TABLE="inet treadle"
NFT_FILE=/var/etc/treadle/treadle.nft

# v4 daddr exclusions: RFC1918, link-local, multicast, CGNAT, reserved.
# Listed once so prerouting + output stay in sync.
V4_RESERVED='0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
			169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24,
			192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16,
			198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
			224.0.0.0/4, 240.0.0.0/4, 255.255.255.255'

V6_RESERVED='::1, ::/128, ::ffff:0.0.0.0/96, 64:ff9b::/96,
			100::/64, 2001::/32, 2001:20::/28, 2001:db8::/32,
			2002::/16, fc00::/7, fe80::/10, ff00::/8'

uci_get() { uci -q get "treadle.$1.$2" 2>/dev/null; }

# Emit `accept` rules for every enabled `bypass` UCI section at the head of
# the prerouting chain — matching LAN packets exit before any TPROXY work,
# so the host's traffic never touches sing-box. Only invoked for tproxy /
# tproxy_mixed modes; in tun mode build-config emits the equivalent
# source_ip_cidr direct rule into the sing-box config instead.
#
# One awk pass over `uci show treadle` instead of three `uci get` forks (plus
# a grep) per section — everything needed is already in that one dump, and
# at ~4 forks per bypass entry the old loop scaled with the bypass list on
# every service start. Validation matches the old greps exactly: nft accepts
# only colon-separated MACs (stricter than the JS validator), the IPv6 shape
# check (2-7 colons, hex groups up to 4 chars, optional /prefix) catches
# typos before nft -f errors out on the whole ruleset. `uci show` always
# wraps option values in single quotes; substr() peels them without the awk
# program needing a literal quote character.
emit_bypasses() {
	# Offsets derive from the prefix length rather than being hard-coded,
	# so they stay right if the config name ever changes.
	uci -q show treadle 2>/dev/null | awk -v P="treadle." '
		BEGIN { pl = length(P) }
		/^treadle\.[^.=]+=bypass$/ {
			sec = substr($0, pl + 1, index($0, "=") - pl - 1)
			if (!(sec in seen)) { seen[sec] = 1; ord[++n] = sec; enabled[sec] = "1" }
			next
		}
		/^treadle\./ {
			eq = index($0, "=")
			if (eq < pl + 3) next
			key = substr($0, pl + 1, eq - pl - 1)
			dot = index(key, ".")
			if (!dot) next
			sec = substr(key, 1, dot - 1)
			if (!(sec in seen)) next
			opt = substr(key, dot + 1)
			val = substr($0, eq + 2, length($0) - eq - 2)
			if (opt == "enabled")    enabled[sec] = val
			else if (opt == "kind")  kind[sec]    = val
			else if (opt == "value") value[sec]   = val
		}
		END {
			for (i = 1; i <= n; i++) {
				sec = ord[i]
				if (enabled[sec] == "0") continue
				v = value[sec]
				if (v == "") continue
				if (kind[sec] == "mac") {
					if (v ~ /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/)
						printf "\t\tether saddr %s accept\n", v
				} else if (kind[sec] == "ip") {
					if (v ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?$/)
						printf "\t\tip saddr %s accept\n", v
					else if (v ~ /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/[0-9]{1,3})?$/)
						printf "\t\tip6 saddr %s accept\n", v
				}
			}
		}
	'
}

# treadle_log
. /usr/libexec/treadle/common.sh

lan_device() {
	local dev
	dev=$(uci -q get network.lan.device 2>/dev/null)
	[ -n "$dev" ] || dev="br-lan"
	echo "$dev"
}

apply_iprules() {
	local inet6
	inet6="$1"

	ip rule del fwmark "$MARK" table "$TABLE" 2>/dev/null
	ip rule add fwmark "$MARK" table "$TABLE"
	ip route replace local 0.0.0.0/0 dev lo table "$TABLE"

	if [ "$inet6" = "1" ]; then
		ip -6 rule del fwmark "$MARK" table "$TABLE" 2>/dev/null
		ip -6 rule add fwmark "$MARK" table "$TABLE"
		ip -6 route replace local ::/0 dev lo table "$TABLE"
	fi
}

remove_iprules() {
	while ip rule del fwmark "$MARK" table "$TABLE" 2>/dev/null; do :; done
	ip route flush table "$TABLE" 2>/dev/null
	while ip -6 rule del fwmark "$MARK" table "$TABLE" 2>/dev/null; do :; done
	ip -6 route flush table "$TABLE" 2>/dev/null
}

build_nft() {
	local port iface inet6 self fakeip fakeip_v4 fakeip_v6
	port="$1"; iface="$2"; inet6="$3"; self="$4"
	fakeip="$5"; fakeip_v4="$6"; fakeip_v6="$7"

	mkdir -p /var/etc/treadle
	{
		echo "table inet treadle {"
		echo "	chain prerouting {"
		echo "		type filter hook prerouting priority mangle; policy accept;"
		echo ""
		# Skip loopback EXCEPT for our own marked traffic looped back from
		# the OUTPUT chain — those packets need to be TPROXY'd here.
		echo "		iif lo meta mark != $MARK accept"
		echo "		meta l4proto != { tcp, udp } accept"
		echo ""
		# Per-host bypass: matching LAN packets exit here, never touching
		# sing-box. Emitted before the fakeip carve-out so a bypassed client
		# whose DNS happens to return a fake-IP-range address still escapes.
		emit_bypasses
		echo ""
		if [ "$fakeip" = "1" ]; then
			# Fake-IP destinations sit inside the reserved ranges below, but a
			# synthetic fake IP is only ever meaningful to sing-box's resolver —
			# TPROXY it (transit and looped-back router traffic alike) before
			# the reserved-range bypass would send it direct.
			echo "		ip daddr $fakeip_v4 meta l4proto tcp tproxy ip to :$port meta mark set $MARK accept"
			echo "		ip daddr $fakeip_v4 meta l4proto udp tproxy ip to :$port meta mark set $MARK accept"
			if [ "$inet6" = "1" ]; then
				echo "		ip6 daddr $fakeip_v6 meta l4proto tcp tproxy ip6 to :$port meta mark set $MARK accept"
				echo "		ip6 daddr $fakeip_v6 meta l4proto udp tproxy ip6 to :$port meta mark set $MARK accept"
			fi
			echo ""
		fi
		echo "		ip daddr {"
		echo "			$V4_RESERVED"
		echo "		} accept"
		if [ "$inet6" = "1" ]; then
			echo "		ip6 daddr {"
			echo "			$V6_RESERVED"
			echo "		} accept"
		else
			echo "		meta nfproto ipv6 accept"
		fi
		echo ""
		# Router-originated traffic looped back via the local route in
		# table $TABLE — already marked by the output chain.
		echo "		meta mark $MARK meta l4proto tcp tproxy ip to :$port accept"
		echo "		meta mark $MARK meta l4proto udp tproxy ip to :$port accept"
		if [ "$inet6" = "1" ]; then
			echo "		meta mark $MARK meta l4proto tcp tproxy ip6 to :$port accept"
			echo "		meta mark $MARK meta l4proto udp tproxy ip6 to :$port accept"
		fi
		echo ""
		# Transit traffic from the LAN bridge.
		echo "		iifname \"$iface\" meta l4proto tcp tproxy ip to :$port meta mark set $MARK accept"
		echo "		iifname \"$iface\" meta l4proto udp tproxy ip to :$port meta mark set $MARK accept"
		if [ "$inet6" = "1" ]; then
			echo "		iifname \"$iface\" meta l4proto tcp tproxy ip6 to :$port meta mark set $MARK accept"
			echo "		iifname \"$iface\" meta l4proto udp tproxy ip6 to :$port meta mark set $MARK accept"
		fi
		echo "	}"

		if [ "$self" = "1" ]; then
			echo ""
			echo "	chain output {"
			# `type route` re-evaluates the routing decision after the
			# mark is set, so policy routing can divert the packet to lo.
			echo "		type route hook output priority mangle; policy accept;"
			echo ""
			# sing-box sets SO_MARK=$SELF_MARK on its outbound sockets via
			# route.default_mark — skip them so we don't loop the proxy.
			echo "		meta mark $SELF_MARK return"
			echo "		oif lo accept"
			echo "		meta l4proto != { tcp, udp } accept"
			echo ""
			if [ "$fakeip" = "1" ]; then
				# Router-originated traffic to a fake IP must be marked so
				# policy routing loops it back through sing-box, rather than
				# being let through by the reserved-range bypass below.
				echo "		ip daddr $fakeip_v4 meta mark set $MARK accept"
				if [ "$inet6" = "1" ]; then
					echo "		ip6 daddr $fakeip_v6 meta mark set $MARK accept"
				fi
				echo ""
			fi
			echo "		ip daddr {"
			echo "			$V4_RESERVED"
			echo "		} accept"
			if [ "$inet6" = "1" ]; then
				echo "		ip6 daddr {"
				echo "			$V6_RESERVED"
				echo "		} accept"
			else
				echo "		meta nfproto ipv6 accept"
			fi
			echo ""
			# Router-originated DNS goes direct. Capturing it would loop:
			# dnsmasq's upstream :53 forwarding gets TPROXY'd into sing-box,
			# whose own resolver depends on dnsmasq (via the local-net
			# server) to resolve the proxy node — a deadlock that kills all
			# router DNS. LAN-client DNS is still hijacked via prerouting.
			echo "		udp dport 53 accept"
			echo "		tcp dport 53 accept"
			echo ""
			echo "		meta mark set $MARK"
			echo "	}"
		fi

		echo "}"
	} > "$NFT_FILE"
}

start() {
	local mode port iface inet6 self fakeip fakeip_v4 fakeip_v6

	# Clear any existing ruleset first so start is idempotent: a mode switch
	# (tproxy -> tun) or a stale ruleset from a crashed run can't leave
	# orphaned nft tables or ip rules behind.
	stop

	mode=$(uci_get inbounds mode)
	[ -n "$mode" ] || mode=tproxy
	case "$mode" in
		tproxy|tproxy_mixed) ;;
		*)
			treadle_log info "firewall: $mode mode, no TPROXY ruleset needed"
			return 0
			;;
	esac

	port=$(uci_get inbounds tproxy_port)
	[ -n "$port" ] || port=7895
	inet6=$(uci_get inbounds inet6)
	self=$(uci_get inbounds tproxy_self)
	[ -n "$self" ] || self=1
	# Basic mode never proxies router-originated traffic — that knob is an
	# Advanced-tier debugging surface, and a Basic user's expectation is "only
	# my LAN clients go through". Override the inbounds.tproxy_self flag so
	# the OUTPUT-chain rules aren't installed in Basic mode regardless of
	# what the saved (Advanced) value was.
	ui_mode=$(uci_get global mode)
	[ "$ui_mode" = "advanced" ] || self=0
	iface=$(lan_device)

	# Fake-IP ranges must be TPROXY'd, not bypassed by the reserved-range
	# accept rules — the addresses are synthetic and only sing-box can demap
	# them. Defaults mirror build-config / the DNS settings tab.
	fakeip=$(uci_get dns fakeip_enabled)
	fakeip_v4=$(uci_get dns fakeip_range_v4)
	[ -n "$fakeip_v4" ] || fakeip_v4='198.18.0.0/15'
	fakeip_v6=$(uci_get dns fakeip_range_v6)
	[ -n "$fakeip_v6" ] || fakeip_v6='fc00::/18'

	apply_iprules "$inet6"
	build_nft "$port" "$iface" "$inet6" "$self" "$fakeip" "$fakeip_v4" "$fakeip_v6"

	if ! nft -f "$NFT_FILE"; then
		treadle_log err "firewall: failed to load nftables ruleset, tearing down"
		stop
		return 1
	fi

	treadle_log info "firewall: TPROXY ruleset applied ($mode, port $port)"
}

stop() {
	# shellcheck disable=SC2086  # "inet treadle" must split into family and name
	nft delete table $NFT_TABLE 2>/dev/null
	remove_iprules
}

# Only start/stop are used (by /etc/init.d/treadle); start is already
# idempotent — it begins with stop — so a separate restart adds nothing.
case "$1" in
	start)   start ;;
	stop)    stop; treadle_log info "firewall: TPROXY ruleset removed" ;;
	*) echo "usage: $0 start|stop" >&2; exit 1 ;;
esac
