#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Install the package built into dist/ (apk or ipk, whichever the image's
# package manager takes) together with packages from the OpenWrt feeds.
# Sourced by smoke.sh and system.sh, which provide die(), $WORK and $OUT:
#
#   install_treadle [<feed package>…]
#
# Sets $PM and $PKG, and $rc to the package manager's exit status for
# Treadle's own package; its output is in $OUT/install.log.
#
# Everything but Treadle's own package comes from the OpenWrt package servers,
# and downloads.openwrt.org sometimes aborts long downloads. When the install
# fails on a download, the feeds are pointed at the next mirror below and the
# install runs again there. Packages are signed (apk checks each package,
# opkg the index and its checksums), so a mirror cannot change what gets
# installed, and the feeds switch as a whole, so an index and its packages
# always come from one server. Two backups from openwrt.org/mirrors, both
# checked to carry both tested releases; the first has delivered every time
# the origin failed on a runner. More only lengthens a run that fails anyway.
# SMOKE_PKG_CACHE, when set, keeps downloaded packages between runs (CI).

MIRRORS="https://downloads.openwrt.org
https://openwrt.pixeldeck.net
https://ftp.halifax.rwth-aachen.de/openwrt"

install_treadle() {
	CACHE=${SMOKE_PKG_CACHE:-}
	if command -v apk >/dev/null 2>&1; then
		PKG=$(ls "$WORK"/dist/*.apk 2>/dev/null | head -n1)
		[ -n "$PKG" ] || die "no .apk in dist/"
		FEEDS=/etc/apk/repositories.d/distfeeds.list
		PM="apk"
		[ -n "$CACHE" ] && PM="apk --cache-dir $CACHE/apk --cache-packages" && mkdir -p "$CACHE/apk"
		pm_install() { $PM add "$@"; }
		pm_install_pkg() { $PM add --allow-untrusted "$PKG"; }
	else
		PKG=$(ls "$WORK"/dist/*.ipk 2>/dev/null | head -n1)
		[ -n "$PKG" ] || die "no .ipk in dist/"
		FEEDS=/etc/opkg/distfeeds.conf
		PM="opkg"
		[ -n "$CACHE" ] && PM="opkg --cache $CACHE/opkg" && mkdir -p "$CACHE/opkg"
		pm_install() { $PM install "$@"; }
		pm_install_pkg() { $PM install "$PKG"; }
	fi

	from=https://downloads.openwrt.org
	installed=
	for mirror in $MIRRORS; do
		if [ "$mirror" != "$from" ]; then
			sed -i "s|$from/|$mirror/|" "$FEEDS"
			from=$mirror
			echo "the last server failed a download; trying $mirror"
		fi
		$PM update >/dev/null 2>&1 || continue
		if [ "$#" -gt 0 ]; then
			pm_install "$@" >/dev/null 2>&1 || continue
		fi
		pm_install_pkg > "$OUT/install.log" 2>&1
		# shellcheck disable=SC2034  # read by the sourcing script
		rc=$?
		grep -qE 'wget: exited|wget returned|Failed to download|Connection (aborted|reset)' "$OUT/install.log" \
			&& continue
		installed=1
		break
	done
	[ -n "$installed" ] || die "no OpenWrt mirror delivered the packages (not a Treadle failure)"
	[ -n "$CACHE" ] && command -v apk >/dev/null 2>&1 && $PM cache clean >/dev/null 2>&1
	return 0
}
