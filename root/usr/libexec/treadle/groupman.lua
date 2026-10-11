-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 RouteWeave
--
-- groupman: how Treadle picks a group's node when it manages the groups
-- (global.group_manager = treadle). The groups run as sing-box selectors, so
-- sing-box never moves one; active-watch feeds this module probe results and
-- connection errors, asks it what each group should use, and applies the
-- answer through the clash API.
--
-- Pure: no I/O, no clock, no randomness of its own. The caller passes `now`
-- and a `rnd(n)` returning an integer in 1..n, so tests/groupman.lua can drive
-- it deterministically.
--
-- The rules, in the order decide() applies them:
--   1. Vote-out. The member in use is benched when too few of its recent
--      probes passed, or when real traffic through it keeps failing (the
--      connection errors sing-box logs), however fast its probes are.
--   2. Failover. The member in use failed FAILS_TO_SWITCH probes in a row, or
--      is benched: move to the best eligible member now.
--   3. Upgrade. Another member scores at least MIN_GAIN lower and more than
--      one tolerance-wide bucket lower, and the current one has been in use
--      for DWELL_S.
-- "Best" is the lowest tolerance-wide bucket of score (see M.score) among
-- eligible members, with a random pick inside it, so near-equal members share
-- the load instead of the first one in a list taking it all.

local M = {}

M.RING            = 10    -- probe outcomes kept per member
M.MIN_SAMPLES     = 5     -- outcomes needed before the success rate counts
M.MIN_RATE        = 0.7   -- below this a member is voted out
M.FAILS_TO_SWITCH = 2     -- probe failures in a row that move the group
M.BENCH_BASE_S    = 120   -- first bench; doubles on each repeat
M.BENCH_MAX_S     = 3600
M.BENCH_RESET_S   = 1800  -- this long without a failure clears the bench level
-- An upgrade (no failure, just a faster member) needs both: DWELL_S on the
-- current member, and a candidate scoring at least MIN_GAIN lower. Replays
-- of recorded probes found the gain rule halves the switching at no cost in
-- delivered latency or failures, and no minimum time from 3 to 30 min
-- delivered measurably better or worse; the shortest leaves a slowed node
-- soonest.
M.DWELL_S         = 180
M.MIN_GAIN        = 0.3
M.ERR_WINDOW_S    = 300
M.ERR_VOTE        = 20    -- connection errors in the window that vote a member out
M.ALPHA           = 0.3   -- weight of a new latency in the running average
M.FAIL_MS         = 3000  -- a failed probe counts as the probe timeout

function M.new()
	return { members = {} }
end

function M.member(st, tag)
	local r = st.members[tag]
	if not r then
		r = { ring = {}, fails = 0, level = 0, errors = {} }
		st.members[tag] = r
	end
	return r
end

-- One probe result: `delay` in ms on success, nil on failure.
function M.record(st, tag, now, delay)
	local r = M.member(st, tag)
	local ok = (delay ~= nil and delay > 0)
	-- The latency itself on success, false on failure.
	r.ring[#r.ring + 1] = ok and delay or false
	while #r.ring > M.RING do table.remove(r.ring, 1) end
	r.tested_at = now
	if ok then
		r.fails = 0
		r.last_ok = now
		r.ewma = r.ewma and (M.ALPHA * delay + (1 - M.ALPHA) * r.ewma) or delay
	else
		r.fails = r.fails + 1
		r.last_fail = now
	end
end

-- Connection errors attributed to a member, as epoch seconds. Old ones fall
-- out of the window.
function M.add_errors(st, tag, now, times)
	local r = M.member(st, tag)
	for _, t in ipairs(times) do r.errors[#r.errors + 1] = t end
	local keep = {}
	for _, t in ipairs(r.errors) do
		if t > now - M.ERR_WINDOW_S then keep[#keep + 1] = t end
	end
	r.errors = keep
end

-- Errors inside the window; the stored list is only pruned when errors are
-- added, so it can hold older ones.
function M.recent_errors(r, now)
	local n = 0
	for _, t in ipairs(r.errors) do
		if t > now - M.ERR_WINDOW_S then n = n + 1 end
	end
	return n
end

function M.rate(r)
	local n, ok = #r.ring, 0
	for _, v in ipairs(r.ring) do if v then ok = ok + 1 end end
	return ok, n
end

function M.benched(r, now)
	return r.bench_until ~= nil and r.bench_until > now
end

function M.bench(r, now)
	r.level = r.level + 1
	local d = M.BENCH_BASE_S * 2 ^ (r.level - 1)
	if d > M.BENCH_MAX_S then d = M.BENCH_MAX_S end
	r.bench_until = now + d
	-- A benched member starts its record afresh when it comes back.
	r.ring, r.errors, r.fails = {}, {}, 0
end

local function poor_rate(r)
	local ok, n = M.rate(r)
	return n >= M.MIN_SAMPLES and ok / n < M.MIN_RATE
end

-- Can this member be chosen? Not benched, a recent success, no failure since,
-- and a decent record.
function M.eligible(r, now, fresh_s)
	return not M.benched(r, now)
		and r.last_ok ~= nil and r.last_ok >= now - fresh_s
		and r.fails == 0
		and not poor_rate(r)
		and M.recent_errors(r, now) < M.ERR_VOTE
end

-- A member's score in ms, lower is better: the median of its last RING
-- results, a failure counting as FAIL_MS, so losses weigh in on the same
-- scale and half of them failing puts the score at the timeout. No spread
-- term: on a router, every node of a provider showed the same occasional
-- slow probe (about one in ten near 700 ms against a 110 ms median), and a
-- high percentile over ten results flipped between the two, so identical
-- nodes kept looking several times faster than each other. An erratic node
-- is still caught by failed probes, the pass rate, benching and speed
-- checks. Entries stored as `true` (an older state file, no latency kept)
-- are left out.
function M.score(r)
	local v = {}
	for _, x in ipairs(r.ring) do
		if x == false then v[#v + 1] = M.FAIL_MS
		elseif type(x) == "number" then v[#v + 1] = x end
	end
	if #v == 0 then return nil end
	table.sort(v)
	return v[math.ceil(#v * 0.5)]
end

local function bucket(r, tolerance)
	return math.floor((M.score(r) or 0) / tolerance)
end

-- The best eligible member other than `except`: lowest bucket, random inside it.
function M.pick(st, members, now, tolerance, fresh_s, rnd, except)
	local best, ties = nil, {}
	for _, tag in ipairs(members) do
		local r = st.members[tag]
		if tag ~= except and r and M.eligible(r, now, fresh_s) then
			local b = bucket(r, tolerance)
			if best == nil or b < best then
				best, ties = b, { tag }
			elseif b == best then
				ties[#ties + 1] = tag
			end
		end
	end
	if #ties == 0 then return nil end
	return ties[rnd(#ties)], best
end

-- What a group should do now. `g` = { now, members, tolerance, fresh_s,
-- last_switch }. Returns { to, reason } to switch, { need_test = true } when
-- the group must move but nothing is known to work, or {} to stay.
function M.decide(st, g, now, rnd)
	local tol = (g.tolerance and g.tolerance >= 1) and g.tolerance or 50
	local cur = M.member(st, g.now)

	for _, tag in ipairs(g.members) do
		local r = st.members[tag]
		if r and r.level > 0 and not M.benched(r, now)
			and (r.last_fail or 0) < now - M.BENCH_RESET_S
		then
			r.level = 0
		end
	end

	local why
	if not M.benched(cur, now) then
		local errs = M.recent_errors(cur, now)
		if errs >= M.ERR_VOTE then
			why = string.format("voted out: %d connection errors in %d min",
				errs, M.ERR_WINDOW_S / 60)
			M.bench(cur, now)
		elseif poor_rate(cur) then
			local ok, n = M.rate(cur)
			why = string.format("voted out: %d of its last %d probes passed", ok, n)
			M.bench(cur, now)
		elseif cur.fails >= M.FAILS_TO_SWITCH then
			why = string.format("failed %d probes in a row", cur.fails)
			M.bench(cur, now)
		end
	else
		why = "benched"
	end

	if why then
		local to = M.pick(st, g.members, now, tol, g.fresh_s, rnd, g.now)
		if to then return { to = to, reason = g.now .. " " .. why } end
		return { need_test = true, reason = g.now .. " " .. why }
	end

	local cur_score = M.score(cur)
	if g.last_switch and now - g.last_switch >= M.DWELL_S and cur_score then
		local to, b = M.pick(st, g.members, now, tol, g.fresh_s, rnd, g.now)
		if to and b < bucket(cur, tol) - 1
			and M.score(st.members[to]) <= (1 - M.MIN_GAIN) * cur_score
		then
			return { to = to, reason = string.format("%s is faster (%d ms against %d ms)",
				to, math.floor(M.score(st.members[to])), math.floor(cur_score)) }
		end
	end
	return {}
end

return M
