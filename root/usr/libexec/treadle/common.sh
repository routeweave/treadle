# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Shared shell helpers for Treadle's scripts (/etc/init.d/treadle,
# firewall.sh and the sing-box start wrapper). POSIX sh — sourced, not
# executed.

# Log a Treadle control-plane event to syslog. $1 is the severity
# (info/notice/warn/err); the remaining args form the message.
treadle_log() {
	local level
	level="$1"
	shift
	# Normalise 'warn' -> 'warning' so the Status-page log filter (which
	# keys SEV by POSIX names) classifies it correctly. busybox logger
	# accepts both spellings.
	[ "$level" = "warn" ] && level=warning
	logger -p "daemon.$level" -t treadle "$@"
}

# Build the sing-box config into $1 and validate it there, with the caller's
# $BUILD_CONFIG and $SINGBOX; the init script and the start wrapper both
# build this way. Returns non-zero when build-config fails or `sing-box
# check` rejects the result; the diagnostics go to syslog either way.
# $2 (optional) is the live config: a build
# identical to it, stamp included, was checked when it was promoted, so the
# check (~120 ms) is skipped for the Saves and reloads that change nothing.
treadle_build_checked() {
	local out="$1" live="$2" cfg_warn chk level ok=0
	if [ -x "$BUILD_CONFIG" ]; then
		# build-config's diagnostics go to stderr; route them into syslog so
		# degraded states (invalid extra.json, dropped DNS rules, WAN-down
		# DNS) stay visible.
		#
		# Severity is per-invocation (warn after a successful run, err after
		# a failed one), which on its own would put routine audit output (the
		# regex-group admit counts, one line per contributing source per
		# group, on every apply) at the same level as "dropping its nodes".
		# Lines build-config tags `info:` are split off and logged at
		# daemon.info so what is left at warn/err is only what actually went
		# wrong. Two grep/logger pipelines rather than a read loop: the cost stays
		# constant instead of forking a logger per diagnostic line, and
		# busybox logger on empty stdin logs nothing, so an absent stream
		# needs no guard.
		cfg_warn=$("$BUILD_CONFIG" "$out" 2>&1 >/dev/null) || ok=1
		if [ -n "$cfg_warn" ]; then
			if [ "$ok" = "0" ]; then level=warn; else level=err; fi
			echo "$cfg_warn" | grep '^treadle build-config: info: ' \
				| sed 's/^treadle build-config: info: /config: /' \
				| logger -p daemon.info -t treadle
			echo "$cfg_warn" | grep -v '^treadle build-config: info: ' \
				| sed 's/^treadle build-config: /config: /' \
				| logger -p "daemon.$level" -t treadle
		fi
	else
		treadle_log err "config: build-config is missing, cannot generate sing-box config"
		return 1
	fi
	[ "$ok" = "0" ] || return 1

	if [ -n "$live" ] && cmp -s "$out" "$live" \
	   && cmp -s "$out.sbver" "$live.sbver"; then
		return 0
	fi

	# Validate the generated config before handing it to procd. sing-box runs
	# under procd `respawn`, so a config it rejects (e.g. a malformed DNS
	# server address) would otherwise crash-loop forever.
	if [ -x "$SINGBOX" ]; then
		chk=$("$SINGBOX" check -c "$out" 2>&1) || {
			[ -n "$chk" ] && echo "$chk" | logger -p daemon.err -t treadle
			return 1
		}
	fi
	return 0
}
