# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI interface for sing-box
LUCI_DEPENDS:=+luci-base +luci-lib-jsonc +sing-box (>=1.12) +rpcd +uclient-fetch +ca-bundle +lua +libuci-lua +nftables-json +kmod-nft-tproxy
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-treadle
# PKG_VERSION/PKG_RELEASE name the version most recently RELEASED — they
# trail the timeline rather than predicting the next release. Bump them in
# the release commit itself; release.yml then verifies the pushed v* tag
# agrees with them and refuses to publish on a mismatch, so the OpenWrt SDK
# build path (which reads these verbatim) and the published package can
# never disagree about what version this tree is.
PKG_VERSION:=0.10.0
PKG_RELEASE:=1
PKG_MAINTAINER:=RouteWeave
PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_URL:=https://github.com/routeweave/treadle

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-treadle/conffiles
/etc/config/treadle
/etc/treadle/extra.json
endef

define Package/luci-app-treadle/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	grep -qsF "/etc/treadle/nodes/" /etc/sysupgrade.conf || echo "/etc/treadle/nodes/" >> /etc/sysupgrade.conf
	/etc/init.d/treadle enable
	service rpcd reload
	# An upgrade swaps the files under a running service, and the old
	# sing-box keeps its old command and config until something reloads it.
	# Reload now so the new version takes effect. A fresh install, or a
	# service the user stopped, is not running and is left alone.
	/etc/init.d/treadle running >/dev/null 2>&1 && /etc/init.d/treadle reload >/dev/null 2>&1
	true
}
endef

# opkg also runs the old package's prerm on an upgrade, as
# `prerm upgrade <new-version>`; apk runs pre-deinstall only on removal. An
# upgrade must leave the service running and its cron jobs in place.
define Package/luci-app-treadle/prerm
#!/bin/sh
[ "$$1" = "upgrade" ] && exit 0
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/treadle stop
	/etc/init.d/treadle disable
	sed -i '/\/usr\/libexec\/treadle\//d' /etc/crontabs/root 2>/dev/null
	/etc/init.d/cron reload 2>/dev/null
	sed -i '\#^/etc/treadle/nodes/$$#d' /etc/sysupgrade.conf 2>/dev/null
}
exit 0
endef

# $(eval $(call BuildPackage,luci-app-treadle)) is called by luci.mk
