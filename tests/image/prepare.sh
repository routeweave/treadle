#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Runs inside the test image build (tests/image/Dockerfile): installs every
# package in the Makefile's LUCI_DEPENDS, plus what the tests use (uhttpd for
# smoke.sh's fixture server, LuCI and curl for system.sh and the browser
# test), then leaves the mark tests/install.sh looks for.

set -eu

DIR=/tmp/treadle-image
OUT=/tmp
die() { printf 'FATAL %s\n' "$*" >&2; exit 1; }

# /var is a link to /tmp, which is empty during an image build, and opkg
# cannot take its lock without /var/lock.
mkdir -p /var/lock /var/run

deps=$(awk -F':=' '$1 == "LUCI_DEPENDS" { print $2; exit }' "$DIR/Makefile" | tr -d '+')
[ -n "$deps" ] || die "no LUCI_DEPENDS in the Makefile"

# shellcheck source=tests/install.sh
. "$DIR/install.sh"
# shellcheck disable=SC2086  # one package name per word
install_feed_packages $deps uhttpd luci curl

for p in $deps uhttpd luci curl; do
	pm_has "$p" || die "$p did not install"
done
command -v sing-box >/dev/null || die "no sing-box after the install"

# The mark records what the image holds, for the test log.
printf '%s, %s, built %s\n' "$(. /etc/openwrt_release && echo "OpenWrt $DISTRIB_RELEASE")" \
	"$(sing-box version | head -n1)" "$(date -u +%Y-%m-%d)" > "$IMAGE_MARK"
cat "$IMAGE_MARK"

# Nothing the image needs to carry: package caches and lists.
rm -rf /var/cache/apk/* /var/opkg-lists/* /tmp/* 2>/dev/null || true
