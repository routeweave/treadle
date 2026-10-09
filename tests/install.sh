#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Package installs for the tests. Sourced by smoke.sh and system.sh, which
# provide die(), $WORK and $OUT, and by tests/image/prepare.sh:
#
#   install_treadle [<feed package>…]   the package built into dist/ (apk or
#                                       ipk, whichever the image takes) plus
#                                       the given feed packages
#   install_feed_packages <package>…    feed packages only (image builds)
#
# install_treadle sets $PM and $PKG, and $rc to the package manager's exit
# status for Treadle's own package; its output is in $OUT/install.log.
#
# On a prebuilt test image (tests/image/, marked by $IMAGE_MARK) every
# dependency is already installed, so Treadle's package goes in offline and
# the run downloads nothing. If that fails (a dependency the image predates,
# say), the full install below runs instead, so a stale image costs time,
# never a wrong result.
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
IMAGE_MARK=/etc/treadle-test-image

pm_setup() {
	CACHE=${SMOKE_PKG_CACHE:-}
	if command -v apk >/dev/null 2>&1; then
		PKG=$(ls "${WORK:-/work}"/dist/*.apk 2>/dev/null | head -n1)
		FEEDS=/etc/apk/repositories.d/distfeeds.list
		PM="apk"
		[ -n "$CACHE" ] && PM="apk --cache-dir $CACHE/apk --cache-packages" && mkdir -p "$CACHE/apk"
		pm_install() { $PM add "$@"; }
		pm_install_pkg() { $PM add --allow-untrusted "$PKG"; }
		pm_install_pkg_offline() { apk add --no-network --allow-untrusted "$PKG"; }
		pm_has() { apk info -e "$1" >/dev/null 2>&1; }
	else
		PKG=$(ls "${WORK:-/work}"/dist/*.ipk 2>/dev/null | head -n1)
		FEEDS=/etc/opkg/distfeeds.conf
		PM="opkg"
		[ -n "$CACHE" ] && PM="opkg --cache $CACHE/opkg" && mkdir -p "$CACHE/opkg"
		pm_install() { $PM install "$@"; }
		pm_install_pkg() { $PM install "$PKG"; }
		pm_install_pkg_offline() { opkg install "$PKG"; }
		pm_has() { opkg list-installed | grep -q "^$1 - "; }
	fi
}

# mirror_loop <step>: run the step (update, then install) against each server
# in turn until one gets through without a download failure.
mirror_loop() {
	from=https://downloads.openwrt.org
	for mirror in $MIRRORS; do
		if [ "$mirror" != "$from" ]; then
			sed -i "s|$from/|$mirror/|" "$FEEDS"
			from=$mirror
			echo "the last server failed a download; trying $mirror"
		fi
		$PM update >/dev/null 2>&1 || continue
		"$@" && return 0
	done
	return 1
}

feed_step() { pm_install "$@" >/dev/null 2>&1; }

install_feed_packages() {
	pm_setup
	mirror_loop feed_step "$@" || die "no OpenWrt mirror delivered: $*"
	[ -n "$CACHE" ] && command -v apk >/dev/null 2>&1 && $PM cache clean >/dev/null 2>&1
	return 0
}

treadle_step() {
	if [ "$#" -gt 0 ]; then
		pm_install "$@" >/dev/null 2>&1 || return 1
	fi
	pm_install_pkg > "$OUT/install.log" 2>&1
	# shellcheck disable=SC2034  # read by the sourcing script
	rc=$?
	! grep -qE 'wget: exited|wget returned|Failed to download|Connection (aborted|reset)' "$OUT/install.log"
}

install_treadle() {
	pm_setup
	[ -n "$PKG" ] || die "no package for $PM in dist/"

	if [ -e "$IMAGE_MARK" ]; then
		missing=
		for p in "$@"; do pm_has "$p" || missing="$missing $p"; done
		if [ -z "$missing" ]; then
			pm_install_pkg_offline > "$OUT/install.log" 2>&1
			rc=$?
			if [ "$rc" -eq 0 ] && [ -e /usr/libexec/rpcd/luci.treadle ]; then
				echo "installed offline on the test image ($(cat "$IMAGE_MARK"))"
				return 0
			fi
			echo "the offline install on the test image failed (exit $rc); installing from the feeds"
			cat "$OUT/install.log"
		else
			echo "the test image lacks$missing; installing from the feeds"
		fi
	fi

	mirror_loop treadle_step "$@" \
		|| die "no OpenWrt mirror delivered the packages (not a Treadle failure)"
	[ -n "$CACHE" ] && command -v apk >/dev/null 2>&1 && $PM cache clean >/dev/null 2>&1
	return 0
}
