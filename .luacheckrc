-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 RouteWeave
--
-- The router runs Lua 5.1. The scripts have no .lua extension, so CI passes
-- them to luacheck by path (see scripts/lint.sh).
std = "lua51"
max_line_length = false
