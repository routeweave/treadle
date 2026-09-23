# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Shared shell helpers for Treadle's scripts (/etc/init.d/treadle and
# firewall.sh). POSIX sh — sourced, not executed.

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
