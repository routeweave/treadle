# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Test image: an OpenWrt rootfs with every package Treadle depends on, and
# what the tests themselves use, already installed, so a CI run installs
# only Treadle's own package and downloads nothing. Built and pushed to GHCR
# by .github/workflows/test-images.yml; see tests/install.sh for how a test
# run uses it, and falls back when it is stale.
#
#   docker build -f tests/image/Dockerfile \
#       --build-arg BASE=openwrt/rootfs:x86_64-25.12.5 .

ARG BASE
FROM ${BASE}

LABEL org.opencontainers.image.source=https://github.com/routeweave/treadle
LABEL org.opencontainers.image.description="OpenWrt with Treadle's dependencies preinstalled, for Treadle's CI"

COPY Makefile tests/install.sh tests/image/prepare.sh /tmp/treadle-image/
RUN sh /tmp/treadle-image/prepare.sh && rm -rf /tmp/treadle-image
