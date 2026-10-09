#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Static checks for the whole tree. CI runs this on every pull request;
# run it locally before pushing.
#
#   sh scripts/lint.sh
#
# Requires shellcheck (>= 0.10, for the busybox dialect), luacheck, node
# and npx (for eslint), and GNU gettext's xgettext (for the .pot check).
# Each check reports every problem it finds, and the script exits non-zero
# if any check failed.

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
root/usr/libexec/treadle/singbox-update
root/usr/libexec/treadle/migrate-basic
root/usr/libexec/treadle/treadlelib.lua
root/usr/libexec/treadle/subparse.lua"

# shellcheck disable=SC2086  # the lists above are newline-separated paths
run "shellcheck (router, busybox)" shellcheck -s busybox -S warning $ROUTER_SH
run "shellcheck (scripts)" shellcheck -S warning scripts/*.sh tests/*.sh
# shellcheck disable=SC2086
run "luacheck (Lua 5.1)" luacheck -q $ROUTER_LUA
run "node field parity (editor vs link import)" sh scripts/check-node-fields.sh
run "views, ACL, handler and menu in step" node scripts/check-consistency.mjs
run "translation template in step with the views" sh scripts/update-pot.sh --check

# The decision log is not published, so nothing here may cite an entry of it
# (CONTRIBUTING.md § Comments): "decision" plus a number, a bare four-digit
# entry number in parentheses, or an audit ID. A file mode written the same
# way trips it too: write it without the parentheses.
no_private_refs() {
	! grep -rnE '[Dd]ecisions? #?[0-9]{3,4}|\(0[0-9]{3}[),;]|SEC-[0-9]' \
		root htdocs scripts tests .github Makefile
}
run "no references to the unpublished decision log" no_private_refs
run "eslint (LuCI views)" npx --yes "eslint@$ESLINT_VERSION" htdocs

[ "$fail" -eq 0 ] && printf 'All checks passed.\n'
exit "$fail"
