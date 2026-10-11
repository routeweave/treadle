-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 RouteWeave
--
-- Offline cases for groupman.lua, the selection policy behind
-- group_manager = treadle. No router needed:
--
--   lua tests/groupman.lua [path/to/groupman.lua]
--
-- smoke.sh runs it against the installed copy under Lua 5.1.

local path = arg[1] or "root/usr/libexec/treadle/groupman.lua"
local gm = dofile(path)

local pass, fail = 0, 0
local function check(cond, what)
	if cond then
		pass = pass + 1
		print("ok   " .. what)
	else
		fail = fail + 1
		print("FAIL " .. what)
	end
end

-- A random source that walks a fixed sequence, so picks are reproducible.
local function seq(...)
	local v, i = { ... }, 0
	return function(n)
		i = i + 1
		local x = v[(i - 1) % #v + 1]
		return (x - 1) % n + 1
	end
end
local first = function() return 1 end

local MEMBERS = { "A", "B", "C", "D" }
local function group(now_tag, extra)
	local g = { now = now_tag, members = MEMBERS, tolerance = 50, fresh_s = 360 }
	for k, v in pairs(extra or {}) do g[k] = v end
	return g
end
local function warm(st, t, delays)
	for tag, d in pairs(delays) do
		for _ = 1, 5 do gm.record(st, tag, t, d) end
	end
end

-- Ties spread: A, B and C sit in one 50 ms bucket, D is slower. Every pick
-- lands in the fast bucket, and over many picks each of A, B, C is chosen.
do
	local st = gm.new()
	warm(st, 1000, { A = 210, B = 220, C = 230, D = 400 })
	local seen = {}
	for i = 1, 30 do
		local tag = gm.pick(st, MEMBERS, 1000, 50, 360, seq(i))
		seen[tag] = (seen[tag] or 0) + 1
	end
	check(seen.A and seen.B and seen.C and not seen.D,
		"near-equal members share the picks, the slow one gets none")
end

-- Stickiness: a faster member does not replace the current one inside the dwell.
do
	local st = gm.new()
	warm(st, 1000, { A = 400, B = 100, C = 120, D = 130 })
	local d = gm.decide(st, group("A", { last_switch = 900 }), 1000, first)
	check(d.to == nil, "no upgrade inside the dwell")
	d = gm.decide(st, group("A", { last_switch = 1000 - gm.DWELL_S }), 1000, first)
	check(d.to == "B" and d.reason:find("faster"), "a member two buckets faster takes over after the dwell")
end

-- One bucket faster is not enough to move.
do
	local st = gm.new()
	warm(st, 1000, { A = 260, B = 210, C = 900, D = 900 })
	local d = gm.decide(st, group("A", { last_switch = 0 }), 1000, first)
	check(d.to == nil, "one bucket faster does not move the group")
end

-- Failover: two probe failures in a row move the group at once, dwell or not,
-- and bench the failed member.
do
	local st = gm.new()
	warm(st, 1000, { A = 200, B = 250, C = 260, D = 270 })
	gm.record(st, "A", 1010, nil)
	local d = gm.decide(st, group("A", { last_switch = 1005 }), 1010, first)
	check(d.to == nil, "one failure alone does not move the group")
	gm.record(st, "A", 1011, nil)
	d = gm.decide(st, group("A", { last_switch = 1005 }), 1011, first)
	check(d.to == "B" and d.reason:find("failed 2 probes"), "two failures in a row fail over")
	check(gm.benched(st.members.A, 1011), "the failed member is benched")
end

-- Vote-out: A is the fastest and passes its latest probe, but fails half of them.
do
	local st = gm.new()
	warm(st, 1000, { B = 300, C = 310, D = 320 })
	for i = 1, 10 do gm.record(st, "A", 1000 + i, (i % 2 == 0) and 90 or nil) end
	local d = gm.decide(st, group("A", { last_switch = 0 }), 1011, first)
	check(d.to == "B" and d.reason:find("voted out"), "a fast but flaky member is voted out")
	check(gm.pick(st, MEMBERS, 1012, 50, 360, first) ~= "A", "a voted-out member is not picked")
end

-- Vote-out by connection errors while every probe passes.
do
	local st = gm.new()
	warm(st, 1000, { A = 100, B = 300, C = 310, D = 320 })
	local t = {}
	for i = 1, gm.ERR_VOTE do t[i] = 900 + i end
	gm.add_errors(st, "A", 1000, t)
	local d = gm.decide(st, group("A", { last_switch = 0 }), 1000, first)
	check(d.to == "B" and d.reason:find("connection errors"), "real-traffic errors vote out a member whose probes pass")
	local st2 = gm.new()
	warm(st2, 1000, { A = 100, B = 300, C = 310, D = 320 })
	gm.add_errors(st2, "A", 1000 + gm.ERR_WINDOW_S + 10, t)
	check(#st2.members.A.errors == 0, "errors older than the window are dropped")
end

-- Bench backoff doubles, caps, and resets after a clean stretch.
do
	local st = gm.new()
	local r = gm.member(st, "A")
	gm.bench(r, 0);   local d1 = r.bench_until
	gm.bench(r, d1);  local d2 = r.bench_until - d1
	check(d1 == gm.BENCH_BASE_S and d2 == 2 * gm.BENCH_BASE_S, "bench doubles: 2 min, then 4 min")
	for _ = 1, 10 do gm.bench(r, 0) end
	check(r.bench_until == gm.BENCH_MAX_S, "bench is capped at an hour")
	r.bench_until, r.last_fail = 10, 10
	warm(st, 5000, { B = 200, C = 200, D = 200 })
	gm.decide(st, group("B"), 10 + gm.BENCH_RESET_S + 1, first)
	check(r.level == 0, "the bench level resets after a clean stretch")
end

-- Nothing known to work: ask for a group test instead of guessing.
do
	local st = gm.new()
	gm.record(st, "A", 1000, nil)
	gm.record(st, "A", 1001, nil)
	local d = gm.decide(st, group("A"), 1001, first)
	check(d.need_test and not d.to, "with no fresh member the group asks for a test")
end

-- Stale results do not count.
do
	local st = gm.new()
	warm(st, 1000, { B = 200 })
	check(gm.pick(st, MEMBERS, 1000 + 361, 50, 360, first) == nil, "a result older than fresh_s is not eligible")
end

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
