#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Container entry point for system.sh: boot OpenWrt with procd as PID 1, so
# rpcd, uhttpd, fw4 and Treadle's init script run as they do on a router.
#
#   docker run -d --cap-add NET_ADMIN -v "$PWD:/work" <openwrt/rootfs image> \
#       /work/tests/boot.sh
#
# /tmp/booted appears once the boot has finished.
#
# The container keeps the network its runtime set up. netifd manages only what
# /etc/config/network names, and config_generate writes that file only when it
# is absent, so a loopback-only file keeps eth0 out of a br-lan bridge. Boot
# still downs eth0, so its address and default route are recorded here and put
# back from rc.local, which runs last. fw4 runs as on a router; eth0 joins the
# lan zone, which accepts input, so the host can reach uhttpd.

cat > /etc/config/network <<'NET'
config interface 'loopback'
	option device 'lo'
	option proto 'static'
	list ipaddr '127.0.0.1/8'
NET
uci add_list firewall.@zone[0].device='eth0'
uci commit firewall

addr=$(ip -4 -o addr show eth0 | awk '{print $4}')
gw=$(ip -4 route show default | awk '{print $3; exit}')
cat > /etc/rc.local <<RC
ip link set eth0 up
ip addr add $addr dev eth0 2>/dev/null
ip route add default via $gw 2>/dev/null
touch /tmp/booted
exit 0
RC
exec /sbin/init
