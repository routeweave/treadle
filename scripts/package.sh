#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Builds APK and IPK packages for luci-app-treadle.
# Runs on Linux with GNU coreutils — not on the router. (Router scripts
# under root/ remain POSIX/busybox-ash compatible.)
#
# Produces unsigned packages installable with:
#   apk add --allow-untrusted luci-app-treadle-*.apk
#   opkg install luci-app-treadle_*.ipk
#
# Requirements:
#   bash, apk-tools 3.x (`apk mkpkg`), fakeroot, tar, gzip,
#   find (GNU), wc, du, awk, sha256sum. git is optional — used only to derive
#   the snapshot version suffix when TREADLE_VERSION is unset.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"
}

for cmd in tar gzip find wc du awk apk fakeroot sha256sum; do
	require_cmd "$cmd"
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_DIR/.build"
STAGE_DIR="$BUILD_DIR/stage"
OUT_DIR="$REPO_DIR/dist"

# ---------------------------------------------------------------------------
# Package metadata
#
# The OpenWrt Makefile is the single source of truth. This standalone builder
# parses the PKG_* / LUCI_* assignments out of it so name, version, release,
# maintainer, license, URL, dependencies and conffiles are never maintained
# in two places.

MAKEFILE="$REPO_DIR/Makefile"
[ -f "$MAKEFILE" ] || die "Makefile not found at $MAKEFILE"

# mk_var NAME — value of a `NAME:=value` assignment, whitespace-trimmed.
mk_var() {
	awk -F':=' -v key="$1" \
		'$1 == key { sub(/^[ \t]+/, "", $2); sub(/[ \t]+$/, "", $2); print $2; exit }' \
		"$MAKEFILE"
}

# mk_block MARKER — body lines of a `MARKER ... endef` define block.
mk_block() {
	awk -v marker="$1" \
		'$0 == marker { grab = 1; next } grab && /^endef/ { exit } grab { print }' \
		"$MAKEFILE"
}

PKG_NAME=$(mk_var PKG_NAME)
PKG_VERSION=$(mk_var PKG_VERSION)
PKG_RELEASE=$(mk_var PKG_RELEASE)
PKG_MAINTAINER=$(mk_var PKG_MAINTAINER)
PKG_LICENSE=$(mk_var PKG_LICENSE)
PKG_URL=$(mk_var PKG_URL)
PKG_DESC=$(mk_var LUCI_TITLE)
LUCI_DEPENDS=$(mk_var LUCI_DEPENDS)
LUCI_PKGARCH=$(mk_var LUCI_PKGARCH)
PKG_CONFFILES=$(mk_block "define Package/${PKG_NAME}/conffiles")

for v in PKG_NAME PKG_VERSION PKG_RELEASE PKG_MAINTAINER PKG_LICENSE \
         PKG_URL PKG_DESC LUCI_DEPENDS LUCI_PKGARCH PKG_CONFFILES; do
	[ -n "${!v}" ] || die "could not parse $v from $MAKEFILE"
done

# Architecture tokens derived from the Makefile's LUCI_PKGARCH, the same way
# OpenWrt's own build system does it (include/package-pack.mk): the ipk
# control file takes LUCI_PKGARCH verbatim, while the apk .PKGINFO uses
# `noarch` for an architecture-independent ("all") package — `all` and
# `noarch` are just the ipk and apk spellings of the same concept, and apk
# rejects the token `all` outright.
PKG_ARCH_IPK="$LUCI_PKGARCH"
case "$LUCI_PKGARCH" in
	*all*) PKG_ARCH_APK=noarch ;;
	*)     PKG_ARCH_APK="$LUCI_PKGARCH" ;;
esac

# APK and IPK dependency strings, both derived from the Makefile's single
# LUCI_DEPENDS list. The two formats differ in version-constraint syntax:
#   APK: "sing-box>=1.12"     (no space, no parentheses)
#   IPK: "sing-box (>= 1.12)" (Debian-style)
# A `(constraint)` token attaches to the package name that precedes it.
PKG_DEPENDS_APK=""
PKG_DEPENDS_IPK=""
for tok in $LUCI_DEPENDS; do
	case "$tok" in
		\(*\))
			constraint=${tok#\(}; constraint=${constraint%\)}
			rel=${constraint%%[0-9]*}
			ver=${constraint#"$rel"}
			PKG_DEPENDS_APK="${PKG_DEPENDS_APK}${constraint}"
			PKG_DEPENDS_IPK="${PKG_DEPENDS_IPK} (${rel} ${ver})"
			;;
		*)
			pkg=${tok#+}
			PKG_DEPENDS_APK="${PKG_DEPENDS_APK:+$PKG_DEPENDS_APK }${pkg}"
			PKG_DEPENDS_IPK="${PKG_DEPENDS_IPK:+$PKG_DEPENDS_IPK, }${pkg}"
			;;
	esac
done

# ---------------------------------------------------------------------------
# Version detection
#
# THE RULES LIVE IN docs/versioning.md. Read it before changing anything
# here; the comments below cover only what is specific to these lines.
# scripts/version-check.sh asserts the result against apk's parser
# and runs in both workflows — add a case there for any change.
#
# Priority:
#   1. TREADLE_VERSION — set by release.yml from a v* tag, already verified
#      against the Makefile.
#   2. A v* tag reachable from HEAD — <last-tag>_git<TS>, the commit's own
#      UTC timestamp. HEAD on the tag drops the suffix.
#   3. No v* tag — <PKG_VERSION>_pre<TS>, the bootstrap before a first release.
#
# TREADLE_RELEASE overrides PKG_RELEASE on all three paths and exists for
# release.yml's v<X.Y.Z>-r<N> tags ONLY. -r<N> is the packaging revision;
# never route a build counter through it.

PKG_RELEASE="${TREADLE_RELEASE:-$PKG_RELEASE}"

if [ -n "${TREADLE_VERSION:-}" ]; then
	PKG_VERSION="$TREADLE_VERSION"
elif command -v git >/dev/null 2>&1 && git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	# Highest-versioned v* tag reachable from HEAD. Not `describe
	# --abbrev=0`: that orders candidates by distance along the commit
	# graph and has no tie-break when several tags share one commit (as
	# they do after a history squash), so it can return an arbitrary one —
	# picking v0.11.0 where v1.1.3 exists builds a snapshot that sorts BELOW
	# the release it actually follows, and the feed then pulls the user
	# back to an older release on the next upgrade.
	#
	# `--sort=-v:refname` orders by version rather than graph distance (so
	# v1.10.0 > v1.2.0, which a lexical sort gets wrong), and `--merged
	# HEAD` keeps describe's guarantee that the base tag is an ancestor —
	# without it a tag on an unrelated branch could win and the on-the-tag
	# check below would be measured against a tag HEAD never descended from.
	LAST_TAG=$(git -C "$REPO_DIR" tag --list 'v[0-9]*' --merged HEAD --sort=-v:refname 2>/dev/null | head -1 || true)

	# HEAD's committer date as UTC YYYYMMDDHHMMSS. `format-local` honours TZ,
	# so TZ=UTC0 pins it regardless of the build host's zone — two builders
	# in different zones must not label the same commit differently.
	# `|| die` hangs off the substitution itself, not off a test of its
	# result: under `set -e` a failing substitution aborts the script before
	# any following test could run, so a `[ -n "$SNAP_TS" ]` guard would
	# never fire and its diagnostic would never reach the log.
	SNAP_TS=$(TZ=UTC0 git -C "$REPO_DIR" log -1 --format=%cd \
		--date=format-local:%Y%m%d%H%M%S 2>/dev/null) \
		|| die "could not read HEAD commit date (shallow clone? need fetch-depth: 0)"

	if [ -n "$LAST_TAG" ]; then
		POST_N=$(git -C "$REPO_DIR" rev-list --count "${LAST_TAG}..HEAD" 2>/dev/null) \
			|| die "could not count commits since ${LAST_TAG} (shallow clone? need fetch-depth: 0)"

		# Split the tag into version and packaging-revision parts the same
		# way release.yml does. A packaging re-release is tagged v1.1.3-r2,
		# and `${LAST_TAG#v}` alone would carry that "-r2" into the version
		# BODY, yielding 1.1.3-r2_git2-r1. apk's grammar treats -r<N> as a
		# terminal revision token, so anything after it fails to parse and
		# `apk mkpkg` rejects the package outright — one such tag would
		# break every snapshot build until the next plain v* tag landed.
		STRIPPED="${LAST_TAG#v}"
		case "$STRIPPED" in
			*-r*)
				BASE_VER="${STRIPPED%-r*}"
				# The tag's own revision wins over the Makefile's: it is
				# what that release was actually published as, and the
				# snapshots that follow it belong to the same lineage.
				# An explicit TREADLE_RELEASE still overrides both.
				PKG_RELEASE="${TREADLE_RELEASE:-${STRIPPED##*-r}}"
				;;
			*)
				BASE_VER="$STRIPPED"
				;;
		esac

		# POST_N is consulted only as a boolean: is HEAD the tagged commit?
		# The suffix itself carries no count.
		if [ "$POST_N" -eq 0 ]; then
			PKG_VERSION="$BASE_VER"
		else
			PKG_VERSION="${BASE_VER}_git${SNAP_TS}"
		fi
	else
		PKG_VERSION="${PKG_VERSION}_pre${SNAP_TS}"
	fi
fi

# Both formats use OpenWrt's <version>-r<release> spelling. This is not the
# Debian convention (<version>-<release>): OpenWrt's own build system derives
# one VERSION for both package formats in include/package-defaults.mk —
#   VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)
# — and its 24.10 feed ships e.g. luci-app-adblock-fast_1.2.4-r4_all.ipk.
# Matching it matters beyond cosmetics: opkg compares revisions Debian-style,
# where the empty non-digit run before "1" sorts below the letter "r", so a
# bare "1.1.3-1" would rank BELOW an SDK- or feed-built "1.1.3-r1" of the very
# same source.
PKG_FULL_VER="${PKG_VERSION}-r${PKG_RELEASE}"

# APK: <name>-<version>-r<release>.apk  (no arch suffix)
APK_FILE="${OUT_DIR}/${PKG_NAME}-${PKG_FULL_VER}.apk"

# IPK: <name>_<version>-r<release>_<arch>.ipk  (matches package-pack.mk)
IPK_FILE="${OUT_DIR}/${PKG_NAME}_${PKG_FULL_VER}_${PKG_ARCH_IPK}.ipk"

printf 'Building APK: %s\n' "$(basename "$APK_FILE")"
printf 'Building IPK: %s\n' "$(basename "$IPK_FILE")"

# ---------------------------------------------------------------------------
# Clean and prepare staging tree. Also clear any prior artifacts for this
# package from dist/, so the run leaves a clean output dir.

rm -rf "$BUILD_DIR"
rm -f "$OUT_DIR"/${PKG_NAME}*.apk "$OUT_DIR"/${PKG_NAME}*.apk.sha256 \
      "$OUT_DIR"/${PKG_NAME}*.ipk "$OUT_DIR"/${PKG_NAME}*.ipk.sha256
mkdir -p "$STAGE_DIR" "$OUT_DIR"

# ---------------------------------------------------------------------------
# strip_comments — remove comment-only lines from staged source so the
# installed package is smaller. Operates on the staged copy only; the
# repo's source files keep their full commentary for maintainers.
#
# Conservative: strips lines whose first non-whitespace run is the
# comment marker. Inline comments (e.g. "code  # note") are left alone,
# string literals containing the comment marker are unaffected, multi-
# line block comments are not touched (verified absent in this repo).
# Shebangs on line 1 are always preserved.
#
# Per-language savings on this codebase (rough):
#   Lua:  ~40% byte reduction (build-config, luci.treadle, active-watch, …)
#   JS:   ~30% byte reduction (status.js, nodes.js, …)
#   sh:   ~15% byte reduction (init.d/treadle, firewall.sh, …)
strip_comments() {
	local dst="$1"
	# The {/SPDX\|Copyright/!d} dance keeps the SPDX-License-Identifier
	# and Copyright lines required for GPL-3.0 redistribution: the inner
	# address skips deletion for any comment line that mentions either
	# keyword. The outer address scopes the rule to comment-only lines,
	# so a code line that happens to contain "Copyright" as a string
	# literal (none today, but future-proof) is unaffected.
	case "$dst" in
		*.js)
			# JS: line comments only (no // mid-line strip — strings).
			sed -i -e '/^[[:space:]]*\/\//{/SPDX\|Copyright/!d;}' "$dst"
			;;
		*.lua|*/luci.treadle|*/build-config|*/active-watch|*/test-all-runner|*/fetch-catalog)
			# Lua: -- line comments. No --[[ ]] blocks in this repo.
			sed -i -e '/^[[:space:]]*--/{/SPDX\|Copyright/!d;}' "$dst"
			;;
		*/init.d/treadle|*.sh|*/sync-subscriptions|*/watchdog|*/hourly)
			# Shell: # line comments, but preserve shebang on line 1
			# (busybox-ash supports both #!/bin/sh and #!/bin/sh /etc/rc.common).
			sed -i -e '1!{/^[[:space:]]*#/{/SPDX\|Copyright/!d;};}' "$dst"
			;;
	esac
}

# htdocs → /www/luci-static/…
mkdir -p "$STAGE_DIR/www/luci-static/resources/view/treadle"
cp -R "$REPO_DIR/htdocs/luci-static/resources/view/treadle/." \
	"$STAGE_DIR/www/luci-static/resources/view/treadle/"
# Strip JS comments from the staged tree.
find "$STAGE_DIR/www/luci-static/resources/view/treadle" -type f -name '*.js' | \
	while IFS= read -r dst; do strip_comments "$dst"; done

# root/ → target filesystem. cp -R preserves source modes; the chmod -R
# normalises them — `X` keeps the executable bit exactly where git set it
# (exec for all if exec for any), i.e. 755 for directories and executables,
# 644 otherwise, independent of the build host's umask.
cp -R "$REPO_DIR/root/." "$STAGE_DIR/"
chmod -R u=rwX,go=rX "$STAGE_DIR"
# extra.json is rewritten with mode 0600 by the rpcd handler the moment the
# user saves overrides (the file may then carry credentials / secret URLs);
# ship the {} default at the same mode so the path never exists with wider
# permissions than its security model assumes. rpcd and build-config both
# run as root, so 0600 costs nothing.
chmod 600 "$STAGE_DIR/etc/treadle/extra.json"
# Strip Lua and shell comments from the staged tree. Path-based dispatch
# in strip_comments matches the helper files by exact name, plus any
# *.lua / *.sh file.
find "$STAGE_DIR" -type f \
	\( -name '*.lua' -o -name '*.sh' \
	   -o -path '*/init.d/treadle' \
	   -o -path '*/libexec/treadle/*' \
	   -o -path '*/libexec/rpcd/luci.treadle' \) | \
	while IFS= read -r dst; do strip_comments "$dst"; done

# ---------------------------------------------------------------------------
# Installed size in bytes — measured now, before the APK-only /lib/apk/
# metadata is staged, so the figure matches the IPK's data.tar payload.
# du is correct regardless of file count (unlike xargs|wc|tail, which
# returns only the last batch's subtotal when xargs splits the input).

SIZE_BYTES=$(du -sb "$STAGE_DIR" | awk '{print $1}')
SIZE_BYTES=${SIZE_BYTES:-0}

# ---------------------------------------------------------------------------
# APK package database metadata (installed to /lib/apk/packages/ on target)
# These tell apk which files belong to the package and which are conffiles.

APKMETA_DIR="$STAGE_DIR/lib/apk/packages"
mkdir -p "$APKMETA_DIR"

find "$STAGE_DIR" \( -type f -o -type l \) -printf '/%P\n' | \
	grep -v '^/lib/apk/' | LC_ALL=C sort \
	> "$APKMETA_DIR/${PKG_NAME}.list"

printf '%s\n' "$PKG_CONFFILES" > "$APKMETA_DIR/${PKG_NAME}.conffiles"

# ---------------------------------------------------------------------------
# Install scripts.
#
# post-install / post-upgrade: register /etc/treadle/nodes/ with sysupgrade so
# a "keep settings" reinstall preserves subscription node data (it can't be a
# conffile — conffiles compare shipped-file checksums, and these per-subscription
# files are never shipped by the package), then enable the init script and
# reload rpcd. The `enable` is essential — this standalone builder does not go
# through the OpenWrt SDK, so nothing else creates the /etc/rc.d/S95treadle
# symlink. Without it the init script is installed but never invoked at boot
# and Treadle never autostarts.
#
# pre-deinstall: stop sing-box, remove the rc.d symlinks, the cron jobs and
# the sysupgrade entry, so an uninstall leaves nothing running or pointing at
# removed files.
#
# Both scripts are the Makefile's postinst / prerm blocks, so the SDK build
# and this one install identical scripts. Make escapes a literal `$` as `$$`
# inside a define; undo that here.

POST_SCRIPT="$BUILD_DIR/post-install.sh"
mk_block "define Package/${PKG_NAME}/postinst" | sed 's/\$\$/$/g' > "$POST_SCRIPT"
[ -s "$POST_SCRIPT" ] || die "could not parse the postinst block from $MAKEFILE"

PRERM_SCRIPT="$BUILD_DIR/pre-deinstall.sh"
mk_block "define Package/${PKG_NAME}/prerm" | sed 's/\$\$/$/g' > "$PRERM_SCRIPT"
[ -s "$PRERM_SCRIPT" ] || die "could not parse the prerm block from $MAKEFILE"

# ---------------------------------------------------------------------------
# Build APK using apk mkpkg (apk-tools 3.x)
# Install with: apk add --allow-untrusted <package>.apk
#
# The staging tree is owned by the unprivileged build user; package files must
# be owned by root. chown the tree to 0:0 and run `apk mkpkg` inside a single
# fakeroot session so the saved-state dance (-s/-i with a state file) is not
# needed.

fakeroot -- sh -c '
	chown -R 0:0 "$1" || exit
	shift
	exec "$@"
' _ "$STAGE_DIR" apk mkpkg \
	--info "name:${PKG_NAME}" \
	--info "version:${PKG_FULL_VER}" \
	--info "description:${PKG_DESC}" \
	--info "arch:${PKG_ARCH_APK}" \
	--info "url:${PKG_URL}" \
	--info "license:${PKG_LICENSE}" \
	--info "maintainer:${PKG_MAINTAINER}" \
	--info "depends:${PKG_DEPENDS_APK}" \
	--script "post-install:${POST_SCRIPT}" \
	--script "post-upgrade:${POST_SCRIPT}" \
	--script "pre-deinstall:${PRERM_SCRIPT}" \
	--files "$STAGE_DIR" \
	--output "$APK_FILE"

sha256sum "$APK_FILE" | awk '{print $1}' > "${APK_FILE}.sha256"

# ---------------------------------------------------------------------------
# Build .ipk (gzip-compressed tar of debian-binary + control.tar.gz +
# data.tar.gz). This is the outer container OpenWrt's own ipkg-build emits by
# default, and the format opkg on 24.10 reliably unpacks. A GNU `ar` archive
# (the Debian .deb container) is NOT a safe substitute here: opkg registers
# such a package and runs its postinst but silently extracts zero files, so
# the app installs yet none of its files — menu.d, acl.d, the rpcd handler —
# ever land on disk. Keep this a tar.gz outer.

IPK_BUILD_DIR="$BUILD_DIR/ipk"
mkdir -p "$IPK_BUILD_DIR/control" "$IPK_BUILD_DIR/data"

# data.tar.gz — package files only (exclude APK-specific /lib/apk/ metadata).
# --owner/--group force root ownership; the build runs as an unprivileged user.
DATA_TAR="$IPK_BUILD_DIR/data.tar.gz"
(cd "$STAGE_DIR" && find . ! -path './lib/apk*' | LC_ALL=C sort | \
	tar --no-recursion --owner=0 --group=0 -czf "$DATA_TAR" -T -)

# IPK depends: libc prepended per OpenWrt convention
IPK_DEPS="libc, ${PKG_DEPENDS_IPK}"

cat > "$IPK_BUILD_DIR/control/control" <<EOF
Package: $PKG_NAME
Version: ${PKG_FULL_VER}
Depends: $IPK_DEPS
Section: luci
Architecture: $PKG_ARCH_IPK
Installed-Size: $SIZE_BYTES
Maintainer: $PKG_MAINTAINER
Description: $PKG_DESC
EOF

printf '%s\n' "$PKG_CONFFILES" > "$IPK_BUILD_DIR/control/conffiles"

# postinst / prerm: the very scripts the APK uses, so both package formats
# behave identically on install, upgrade and removal.
cp "$POST_SCRIPT"  "$IPK_BUILD_DIR/control/postinst"
cp "$PRERM_SCRIPT" "$IPK_BUILD_DIR/control/prerm"
chmod 755 "$IPK_BUILD_DIR/control/postinst" "$IPK_BUILD_DIR/control/prerm"

IPK_CTRL_TAR="$IPK_BUILD_DIR/control.tar.gz"
(cd "$IPK_BUILD_DIR/control" && tar --owner=0 --group=0 -czf "$IPK_CTRL_TAR" ./control ./conffiles ./postinst ./prerm)

printf '2.0\n' > "$IPK_BUILD_DIR/debian-binary"
# Pack the three members into a gzip-compressed tar outer (member order matches
# OpenWrt's ipkg-build: debian-binary, data, control). Recreate from scratch so
# a rebuild at the same version never inherits stale bytes.
rm -f "$IPK_FILE"
(cd "$IPK_BUILD_DIR" && tar --owner=0 --group=0 -czf "$IPK_FILE" \
	./debian-binary ./data.tar.gz ./control.tar.gz)
sha256sum "$IPK_FILE" | awk '{print $1}' > "${IPK_FILE}.sha256"

# ---------------------------------------------------------------------------

APK_BASE="$(basename "$APK_FILE")"
IPK_BASE="$(basename "$IPK_FILE")"
printf 'APK:     %s  (%d bytes)\n' "$APK_BASE" "$(wc -c < "$APK_FILE")"
printf 'SHA256:  %s\n' "$(cat "${APK_FILE}.sha256")"
printf 'IPK:     %s  (%d bytes)\n' "$IPK_BASE" "$(wc -c < "$IPK_FILE")"
printf 'SHA256:  %s\n' "$(cat "${IPK_FILE}.sha256")"
printf '\nInstall on router (APK; post-install reloads rpcd automatically):\n'
printf '  scp %s root@<router-ip>:/tmp/\n' "$APK_BASE"
printf '  ssh root@<router-ip> '\''apk add --allow-untrusted /tmp/%s'\''\n' "$APK_BASE"
printf '\nInstall on router (IPK/opkg):\n'
printf '  scp %s root@<router-ip>:/tmp/\n' "$IPK_BASE"
printf '  ssh root@<router-ip> '\''opkg install /tmp/%s'\''\n' "$IPK_BASE"
