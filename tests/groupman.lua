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

-- The gain rule: two buckets faster is not enough unless it is also at least
-- MIN_GAIN faster.
do
	local st = gm.new()
	warm(st, 1000, { A = 400, B = 300 })
	local d = gm.decide(st, group("A", { last_switch = 0 }), 1000, first)
	check(d.to == nil, "25% faster does not move the group")
	warm(st, 1000, { C = 250 })   -- C and D had no results until now
	d = gm.decide(st, group("A", { last_switch = 0 }), 1000, first)
	check(d.to == "C", "37% faster does")
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

-- The pattern seen on a router: every node of a provider answers in about
-- 110 ms with an occasional probe near 700 ms. Identical nodes must not trade
-- places because the slow probes happen to fall in one node's window.
do
	local st = gm.new()
	local a = { 110, 108, 700, 112, 109, 111, 700, 110, 107, 113 }
	local b = { 112, 700, 111, 109, 110, 112, 108, 111, 110, 109 }
	for i = 1, 10 do
		gm.record(st, "A", 1000, a[i]); gm.record(st, "B", 1000, b[i])
		gm.record(st, "C", 1000, 900); gm.record(st, "D", 1000, 900)
	end
	check(math.abs(gm.score(st.members.A) - gm.score(st.members.B)) < 5, "occasional slow probes leave identical nodes level")
	local d = gm.decide(st, group("A", { last_switch = 0 }), 1000, first)
	check(d.to == nil, "and the group stays where it is")
end

-- Failures count as the probe timeout: a few leave the median alone (the
-- pass rate and failover handle them), more than half put it at the timeout.
do
	local st = gm.new()
	local function d(lost) if lost then return nil end return 200 end
	for i = 1, 10 do gm.record(st, "A", 1000, d(i == 3 or i == 7)) end
	for i = 1, 10 do gm.record(st, "B", 1000, d(i <= 6)) end
	check(gm.score(st.members.A) == 200, "two failures in ten leave the score alone")
	check(gm.score(st.members.B) == gm.FAIL_MS, "six in ten put it at the timeout")
end

-- Speed: the member in use against the best other member, measured back to
-- back. One result under half does not move the group; two in a row bench
-- the member and move to the faster one; a normal result clears the run;
-- congestion that slows both moves nothing.
do
	local st = gm.new()
	local MB = 1e6 / 8   -- 1 Mbit/s in bytes/s
	warm(st, 4000, { A = 200, B = 210, C = 220, D = 900 })
	check(gm.record_speed(st, "A", "B", 4000, 15 * MB, 40 * MB) == true, "under half the alternative's speed is low")
	local d = gm.decide(st, group("A", { last_switch = 3990 }), 4000, first)
	check(d.to == nil, "one low result does not move the group")
	gm.record_speed(st, "A", "C", 4120, 12 * MB, 35 * MB)
	warm(st, 4110, { A = 200, B = 210, C = 220 })
	d = gm.decide(st, group("A", { last_switch = 3990 }), 4120, first)
	check(d.to == "C" and d.reason:find("under half"), "two in a row move the group to the faster member")
	check(gm.benched(st.members.A, 4120), "and bench the slow one")
	local st2 = gm.new()
	gm.record_speed(st2, "A", "B", 0, 15 * MB, 40 * MB)
	gm.record_speed(st2, "A", "B", 1, 30 * MB, 40 * MB)
	check(st2.members.A.speed_low == 0, "a normal result in between clears the run")
	check(gm.record_speed(st2, "A", "B", 2, 6 * MB, 9 * MB) == false, "both slow (shared congestion) is not low")
end

-- The level behind "latency got worse": it starts at the first score, a
-- sudden climb to 1.5x is flagged, and a lasting change becomes the level.
do
	local st = gm.new()
	warm(st, 0, { A = 200 })
	local r = st.members.A
	check(gm.track_level(r, 0) == false and r.level_score == 200, "the level starts at the first score")
	for _ = 1, 10 do gm.record(st, "A", 10, 400) end
	check(gm.track_level(r, 10) == true, "a score twice the level is flagged")
	for t = 20, 3600 * 3, 10 do gm.track_level(r, t) end
	check(math.abs(r.level_score - 400) < 5, "after hours at the new score it is the level")
	check(gm.track_level(r, 3600 * 3 + 10) == false, "and is no longer flagged")
end

print(string.format("\n%d passed, %d failed", pass, fail))
os.exit(fail == 0 and 0 or 1)
