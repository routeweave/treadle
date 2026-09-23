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
PKG_VERSION:=0.1.0
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
}
endef

define Package/luci-app-treadle/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/treadle stop
	/etc/init.d/treadle disable
}
endef

# $(eval $(call BuildPackage,luci-app-treadle)) is called by luci.mk
