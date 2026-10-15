#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Checks Treadle's version scheme against apk's own parser, so a change to the
# version-building code in package.sh cannot quietly start emitting strings
# apk rejects or orders the wrong way. The scheme has two shapes, a release
# (1.2.0-r1) and a snapshot past it (1.2.0_git<TS>-r1); see
# docs/versioning.md.
#
# Usage:
#   version-check.sh              — run the built-in matrix
#   version-check.sh <version>…   — also require each given version to be
#                                   valid (CI passes the version it just built)
#
# Requires apk-tools 3.x. dpkg is optional — when present it stands in for
# opkg on the ipk ordering checks (see the block near the bottom).
#
# `apk version -c` prints each invalid argument and
# exits with the count of them; `apk version -t A B` prints <, = or >.
set -euo pipefail

command -v apk >/dev/null 2>&1 || {
	printf 'error: apk not found in PATH (apk-tools 3.x required)\n' >&2
	exit 1
}

fail=0
note() { printf '  %-34s %s\n' "$1" "$2"; }

# --- versions the scheme is allowed to produce --------------------------------
# A release and a snapshot (commit timestamp in the body).
VALID="
1.2.0-r1
1.2.0_git20260105083000-r1
1.10.0-r1
"

# --- versions that must NOT parse ---------------------------------------------
# The first is the Debian release separator, which OpenWrt does not use and
# apk does not accept (see openwrt/openwrt#15656, "1.2-1" rejected).
#
# The second is why a release candidate is not simply a matter of picking
# Debian's spelling: "~rc1" reads to opkg as a pre-release sorting below
# 1.2.0, which is exactly what an RC needs — but apk spans HEX DIGITS after
# "~" and requires at least one, and "r" is not hex, so the version does not
# parse at all. Pinned here so the next person to want an RC learns it from a
# failing assertion rather than from a rejected package. See
# docs/versioning.md § "Release candidates are unsolved, not forbidden".
INVALID="
1.2.0-1
1.2.0~rc1
"

# --- orderings the documented guarantee depends on ----------------------------
# Each line is "A|B" and must compare strictly A < B. Together these assert:
# a snapshot sorts above the release it follows; snapshots advance with the
# commit timestamp alone; the next release outranks every snapshot of the
# previous one.
ORDER="
1.2.0-r1|1.2.0_git20260105083000-r1
1.2.0_git20260105083000-r1|1.2.0_git20260105090000-r1
1.2.0_git20260105083000-r1|1.2.0_git20260106010000-r1
1.2.0_git20260105083000-r1|1.10.0-r1
"

printf 'Valid versions\n'
for v in $VALID "$@"; do
	[ -n "$v" ] || continue
	if apk version -c "$v" >/dev/null 2>&1; then
		note "$v" "ok"
	else
		note "$v" "REJECTED by apk — expected valid"
		fail=1
	fi
done

printf '\nRejected versions\n'
for v in $INVALID; do
	[ -n "$v" ] || continue
	if apk version -c "$v" >/dev/null 2>&1; then
		note "$v" "ACCEPTED by apk — expected rejected"
		fail=1
	else
		note "$v" "ok (rejected)"
	fi
done

printf '\nOrdering\n'
for pair in $ORDER; do
	[ -n "$pair" ] || continue
	a="${pair%%|*}"
	b="${pair##*|}"
	op=$(apk version -t "$a" "$b" 2>/dev/null || echo '?')
	if [ "$op" = "<" ]; then
		note "$a < $b" "ok"
	else
		note "$a ? $b" "apk says '${op}' — expected '<'"
		fail=1
	fi
done

# --- the same orderings under opkg, checked through dpkg ----------------------
#
# The apk checks above ask the real parser. The ipk side deserves the same, and
# hand-porting opkg's verrevcmp() into shell would not be it — the test would
# then be a reimplementation that can be wrong in exactly the way it is meant
# to catch.
#
# dpkg is the stand-in. opkg's comparison IS dpkg's: `order()` and
# `verrevcmp()` in libopkg/pkg.c match dpkg's, and dpkg ships on every CI
# runner, so this is a real implementation of the same algorithm rather than a
# model of it. It is a different codebase, so it would not catch opkg diverging
# from dpkg in future — that is the limit of what this buys.
#
# Debian's upstream_version grammar excludes "_", which the snapshot suffix
# uses, so dpkg may refuse these versions outright. Probe first and skip
# loudly if so: a silently-skipped check is worse than an absent one.

OPKG_ORDER="
1.1.3-1|1.1.3-r1
1.2.0-r1|1.2.0_git20260105083000-r1
1.2.0_git20260105083000-r1|1.2.0_git20260105090000-r1
1.2.0_git20260105083000-r1|1.10.0-r1
"

printf '\nOrdering under opkg (via dpkg)\n'
if ! command -v dpkg >/dev/null 2>&1; then
	note "dpkg not on PATH" "SKIPPED — ipk ordering unchecked"
elif ! dpkg --compare-versions '1.0_git1' eq '1.0_git1' >/dev/null 2>&1; then
	# Identical strings must compare equal; a failure here means dpkg
	# rejected the version rather than that the relation was false.
	note "dpkg rejects '_' in a version" "SKIPPED — ipk ordering unchecked"
else
	for pair in $OPKG_ORDER; do
		[ -n "$pair" ] || continue
		a="${pair%%|*}"
		b="${pair##*|}"
		if dpkg --compare-versions "$a" lt "$b" >/dev/null 2>&1; then
			note "$a < $b" "ok"
		else
			note "$a ? $b" "dpkg does not put it below — expected '<'"
			fail=1
		fi
	done
fi

printf '\n'
if [ "$fail" -ne 0 ]; then
	printf 'version-check: FAILED\n' >&2
	exit 1
fi
printf 'version-check: all checks passed\n'
