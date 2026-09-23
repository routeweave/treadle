#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Static checks for the whole tree. CI runs this on every pull request;
# run it locally before pushing.
#
#   sh scripts/lint.sh
#
# Requires shellcheck (>= 0.10, for the busybox dialect), luacheck and
# npx (for eslint). Each check reports every problem it finds, and the
# script exits non-zero if any check failed.

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1

ESLINT_VERSION=10.11.0

fail=0
run() {
	printf '==> %s\n' "$1"
	shift
	"$@" || fail=1
}

# Router shell code runs under busybox ash; the scripts here run on the
# build host or a developer machine.
ROUTER_SH="root/etc/init.d/treadle
root/usr/libexec/treadle/common.sh
root/usr/libexec/treadle/firewall.sh
root/usr/libexec/treadle/watchdog
root/usr/libexec/treadle/hourly
root/usr/libexec/treadle/sync-subscriptions"

# The router Lua has no .lua extension (rpcd and procd exec it by path),
# so list it explicitly.
ROUTER_LUA="root/usr/libexec/rpcd/luci.treadle
root/usr/libexec/treadle/build-config
root/usr/libexec/treadle/active-watch
root/usr/libexec/treadle/test-all-runner
root/usr/libexec/treadle/fetch-catalog
root/usr/libexec/treadle/treadlelib.lua"

# shellcheck disable=SC2086  # the lists above are newline-separated paths
run "shellcheck (router, busybox)" shellcheck -s busybox -S warning $ROUTER_SH
run "shellcheck (scripts)" shellcheck -S warning scripts/*.sh tests/*.sh
# shellcheck disable=SC2086
run "luacheck (Lua 5.1)" luacheck -q $ROUTER_LUA
run "eslint (LuCI views)" npx --yes "eslint@$ESLINT_VERSION" htdocs

[ "$fail" -eq 0 ] && printf 'All checks passed.\n'
exit "$fail"
