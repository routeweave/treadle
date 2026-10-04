-- SPDX-License-Identifier: GPL-3.0-only
-- Copyright (C) 2026 RouteWeave
--
-- Subscription and share-link parsing for the rpcd handler luci.treadle:
-- sing-box JSON, Clash YAML and base64 or plain URI lists, each turned into
-- sing-box outbounds. rpcd starts a fresh Lua process for every call and
-- compiles the whole handler each time, and this code was about half of it,
-- so the handler loads it only for the calls that parse (subscription syncs
-- and parse_node_link) instead of on every Status-page poll. Loaded with
-- loadfile(path)(lib), so it shares the caller's treadlelib. Lua 5.1 only.

local lib = ...
local _jsonc = require "luci.jsonc"

-- Base64 decode table covering both standard (+/) and URL-safe (-_) alphabets.
local B64_DEC = {}
do
	local alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for i = 1, #alpha do B64_DEC[alpha:sub(i, i)] = i - 1 end
	B64_DEC["-"] = 62  -- URL-safe alternative for +
	B64_DEC["_"] = 63  -- URL-safe alternative for /
end

-- Decode a Base64 string (standard or URL-safe, with or without padding).
-- Uses only Lua 5.1 arithmetic — no bit library required.
local function base64_decode(s)
	s = s:gsub("[^A-Za-z0-9+/%-_=]", "")
	s = s:gsub("%-", "+"):gsub("_", "/")  -- normalise URL-safe to standard
	local pad = #s % 4
	if pad == 2 then s = s .. "=="
	elseif pad == 3 then s = s .. "=" end
	local out = {}
	for i = 1, #s - 3, 4 do
		local a = B64_DEC[s:sub(i,   i  )] or 0
		local b = B64_DEC[s:sub(i+1, i+1)] or 0
		local c = B64_DEC[s:sub(i+2, i+2)] or 0
		local d = B64_DEC[s:sub(i+3, i+3)] or 0
		-- Pack four 6-bit values into three bytes using arithmetic (no bit ops)
		local n = a * 262144 + b * 4096 + c * 64 + d
		out[#out + 1] = string.char(math.floor(n / 65536))
		if s:sub(i+2, i+2) ~= "=" then
			out[#out + 1] = string.char(math.floor(n / 256) % 256)
		end
		if s:sub(i+3, i+3) ~= "=" then
			out[#out + 1] = string.char(n % 256)
		end
	end
	return table.concat(out)
end

-- Parse a single proxy URI line into a complete sing-box outbound object
-- (tag, type, server, server_port plus all protocol-specific fields like
-- uuid, password, tls, transport, etc.). Returns nil if the line can't be
-- recognised. The result is meant to be serialised verbatim as the outbound's
-- payload, so it must contain everything sing-box needs to actually connect.

-- URL-decode a percent-encoded string (handles +→space too, since some
-- producers URL-encode query params that way).
local function url_decode(s)
	if not s then return "" end
	return (s:gsub("%+", " "):gsub("%%(%x%x)", function(h)
		return string.char(tonumber(h, 16))
	end))
end

-- Split a URI userinfo into (user, pass) on the first ':'. Decode first
-- because some generators percent-encode the separator as %3A (RFC 3986
-- allows it inside userinfo), which would otherwise hide the split and
-- collapse user:pass into a single field.
local function split_userinfo(ui)
	local decoded = url_decode(ui or "")
	local a, b = decoded:match("^([^:]*):(.*)$")
	if a then return a, b end
	return decoded, nil
end

-- Parse "k1=v1&k2=v2&..." into { [k]=v } with URL-decoded keys and values.
local function parse_query(s)
	local q = {}
	if not s or s == "" then return q end
	for pair in s:gmatch("[^&]+") do
		local k, v = pair:match("^([^=]+)=(.*)$")
		if k then
			q[url_decode(k)] = url_decode(v)
		else
			q[url_decode(pair)] = ""
		end
	end
	return q
end

-- Split a CSV string into an array, returning nil for empty input so the
-- caller can omit the field cleanly.
local function split_csv(s)
	if not s or s == "" then return nil end
	local out = {}
	for part in s:gmatch("[^,]+") do
		part = part:match("^%s*(.-)%s*$")
		if part ~= "" then out[#out + 1] = part end
	end
	return #out > 0 and out or nil
end

-- Pull a host and numeric port out of "host:port" or "[v6host]:port".
local function split_host_port(s)
	-- The authority ends at the first '/' (RFC 3986): subscription
	-- generators commonly emit "host:port/?query", and a kept path would
	-- make the trailing-digits port match below fail on every such URI.
	s = s:match("^%s*(.-)%s*$"):gsub("/.*$", "")
	local h, p = s:match("^%[([^%]]+)%]:(%d+)$")
	if not h then h, p = s:match("^(.+):(%d+)$") end
	return h, tonumber(p)
end

-- Build the sing-box `tls` sub-block from a URI query table. Returns nil
-- when the URI doesn't request TLS so we don't emit an empty block. For
-- protocols that are always TLS (hysteria2, tuic, anytls), the caller
-- should pre-seed q.security = "tls" before calling.
local function build_tls_from_query(q)
	local sec = q.security or ""
	if sec ~= "tls" and sec ~= "reality" and sec ~= "xtls" then return nil end
	local tls = { enabled = true }
	if q.sni and q.sni ~= "" then tls.server_name = q.sni end
	if q.allowInsecure == "1" or q.insecure == "1" or q.allow_insecure == "1" then
		tls.insecure = true
	end
	local alpn = split_csv(q.alpn)
	if alpn then tls.alpn = alpn end
	if q.fp and q.fp ~= "" then
		tls.utls = { enabled = true, fingerprint = q.fp }
	end
	if sec == "reality" then
		tls.reality = { enabled = true }
		if q.pbk and q.pbk ~= "" then tls.reality.public_key = q.pbk end
		if q.sid and q.sid ~= "" then tls.reality.short_id  = q.sid end
	end
	return tls
end

-- Build the sing-box `transport` sub-block from a URI query table.
-- Returns nil for tcp/raw (the default has no transport block), or
-- nil plus a reason when the URI names a transport sing-box cannot dial
-- (Xray's `xhttp`, say) — the caller rejects the node rather than building
-- it without the transport and letting every handshake fail.
local function build_transport_from_query(q)
	local t = (q.type or "tcp"):lower()
	if t == "" or t == "tcp" or t == "raw" then return nil end
	-- XHTTP is not a sing-box transport, but its stream-one mode is the
	-- same wire shape as sing-box's `http`; map it instead of rejecting.
	if t == "xhttp" then
		return lib.map_xhttp_transport(q.path, q.host, q.mode)
	end
	if not lib.SUPPORTED_TRANSPORTS[t] and t ~= "h2" then
		return nil, "transport '" .. t .. "' is not supported by sing-box"
	end
	if t == "ws" then
		local tr = { type = "ws" }
		if q.path and q.path ~= "" then tr.path = q.path end
		if q.host and q.host ~= "" then tr.headers = { Host = q.host } end
		return tr
	end
	if t == "grpc" then
		local tr = { type = "grpc" }
		local sn = q.serviceName or q.service_name
		if sn and sn ~= "" then tr.service_name = sn end
		return tr
	end
	if t == "http" or t == "h2" then
		local tr = { type = "http" }
		if q.path and q.path ~= "" then tr.path = q.path end
		local hosts = split_csv(q.host)
		if hosts then tr.host = hosts end
		return tr
	end
	if t == "httpupgrade" then
		local tr = { type = "httpupgrade" }
		if q.path and q.path ~= "" then tr.path = q.path end
		if q.host and q.host ~= "" then tr.host = q.host end
		return tr
	end
	-- quic: sing-box takes an options-less transport block.
	return { type = t }
end

-- Shallow-copy a query table then force security="tls". Used for protocols
-- that are unconditionally TLS so build_tls_from_query produces the block.
local function force_tls(q)
	local out = {}
	for k, v in pairs(q) do out[k] = v end
	out.security = "tls"
	return out
end

-- Hysteria2 port hopping range, as Clash's `ports` and a link's `mport`
-- write it ("443,20000-30000", comma- or slash-separated), in sing-box's
-- `server_ports` shape (["443:443", "20000:30000"]). Only the syntax is
-- translated: build-config's sanitiser validates the ranges for every
-- subscription format. Returns nil for an empty value.
local function hy2_server_ports(s)
	if not s or s == "" then return nil end
	local list = {}
	for item in tostring(s):gmatch("[^,/%s]+") do
		local lo, hi = item:match("^(%d+)%-(%d+)$")
		if lo then
			list[#list + 1] = lo .. ":" .. hi
		else
			list[#list + 1] = item:match("^%d+$") and (item .. ":" .. item) or item
		end
	end
	return (#list > 0) and list or nil
end

local function parse_proxy_uri(line)
	line = line:match("^%s*(.-)%s*$")
	local scheme = line:match("^([a-z][a-z0-9+%-]*)://")
	if not scheme then return nil end
	local body = line:sub(#scheme + 4)   -- everything after "://"

	-- Display name (URL-encoded) lives in the fragment.
	local name
	local frag = body:find("#")
	if frag then
		name = url_decode(body:sub(frag + 1)):match("^%s*(.-)%s*$")
		if name == "" then name = nil end
		body = body:sub(1, frag - 1)
	end

	-- VMess: base64-encoded JSON, no userinfo@host:port structure.
	if scheme == "vmess" then
		local b64 = body:match("^([^?]+)") or ""
		local ok, o = pcall(_jsonc.parse, base64_decode(b64))
		if not ok or type(o) ~= "table" then return nil end
		local server = type(o.add) == "string" and o.add or ""
		if server == "" then return nil end
		local tag = name or (type(o.ps) == "string" and o.ps ~= "" and o.ps) or server
		local ob = {
			type        = "vmess",
			tag         = tag,
			server      = server,
			server_port = tonumber(o.port) or 0,
			uuid        = type(o.id) == "string" and o.id or "",
			alter_id    = tonumber(o.aid) or 0,
			security    = (type(o.scy) == "string" and o.scy ~= "" and o.scy) or "auto"
		}
		local net = (type(o.net) == "string" and o.net or "tcp"):lower()
		if net == "xhttp" then
			local tr, reason = lib.map_xhttp_transport(o.path, o.host, o.mode)
			if not tr then return nil, tag .. ": " .. reason end
			ob.transport = tr
		elseif net ~= "" and net ~= "tcp" and net ~= "raw"
		   and not lib.SUPPORTED_TRANSPORTS[net] and net ~= "h2" then
			return nil, tag .. ": transport '" .. net .. "' is not supported by sing-box"
		end
		if net == "ws" then
			ob.transport = { type = "ws" }
			if o.path and o.path ~= "" then ob.transport.path = o.path end
			if o.host and o.host ~= "" then ob.transport.headers = { Host = o.host } end
		elseif net == "grpc" then
			ob.transport = { type = "grpc" }
			if o.path and o.path ~= "" then ob.transport.service_name = o.path end
		elseif net == "h2" or net == "http" then
			ob.transport = { type = "http" }
			if o.path and o.path ~= "" then ob.transport.path = o.path end
			local hosts = split_csv(o.host)
			if hosts then ob.transport.host = hosts end
		end
		if o.tls == "tls" or o.tls == "reality" then
			ob.tls = { enabled = true }
			local sni = (o.sni and o.sni ~= "" and o.sni) or
			            (o.host and o.host ~= "" and o.host) or nil
			if sni then ob.tls.server_name = sni end
			local alpn = split_csv(o.alpn)
			if alpn then ob.tls.alpn = alpn end
			if o.fp and o.fp ~= "" then
				ob.tls.utls = { enabled = true, fingerprint = o.fp }
			end
		end
		return ob
	end

	-- Shadowsocks has two URI shapes; handle both before the userinfo split.
	if scheme == "ss" then
		local at = body:find("@")
		local method, password, host, port
		if at then
			local userinfo = body:sub(1, at - 1)
			local rest = body:sub(at + 1)
			local hostport = rest:match("^([^?]+)") or rest
			host, port = split_host_port(hostport)
			if not host then return nil end
			local decoded = base64_decode(userinfo)
			method, password = decoded:match("^(.-):(.+)$")
			if not method then
				decoded = url_decode(userinfo)
				method, password = decoded:match("^(.-):(.+)$")
			end
		else
			local b64 = body:match("^([^?]+)") or ""
			local dec = base64_decode(b64)
			method, password, host, port = dec:match("^(.-):(.-)@(.+):(%d+)$")
			if not method then return nil end
			port = tonumber(port)
		end
		return {
			type        = "shadowsocks",
			tag         = name or host,
			server      = host,
			server_port = port or 0,
			method      = method or "",
			password    = password or ""
		}
	end

	-- Remaining protocols share the userinfo@host:port?query shape.
	local at = body:find("@")
	if not at then return nil end
	local userinfo = body:sub(1, at - 1)
	local rest     = body:sub(at + 1)
	local hostport, qstr = rest:match("^([^?]+)%?(.*)$")
	if not hostport then hostport = rest; qstr = "" end
	local h, p = split_host_port(hostport)
	if not h then return nil end
	local q = parse_query(qstr)
	local tag = name or h

	if scheme == "vless" then
		local ob = {
			type = "vless", tag = tag, server = h, server_port = p or 0,
			uuid = url_decode(userinfo)
		}
		if q.flow and q.flow ~= "" then ob.flow = q.flow end
		local tls = build_tls_from_query(q);       if tls then ob.tls = tls end
		local tr, reject = build_transport_from_query(q)
		if reject then return nil, tag .. ": " .. reject end
		if tr then ob.transport = tr end
		return ob
	end

	if scheme == "trojan" then
		local ob = {
			type = "trojan", tag = tag, server = h, server_port = p or 0,
			password = url_decode(userinfo)
		}
		local tls = build_tls_from_query(force_tls(q));  if tls then ob.tls = tls end
		local tr, reject = build_transport_from_query(q)
		if reject then return nil, tag .. ": " .. reject end
		if tr then ob.transport = tr end
		return ob
	end

	if scheme == "hysteria2" or scheme == "hy2" then
		local ob = {
			type = "hysteria2", tag = tag, server = h, server_port = p or 0,
			password = url_decode(userinfo)
		}
		local tls = build_tls_from_query(force_tls(q))
		if tls then ob.tls = tls end
		if q.obfs and q.obfs ~= "" then
			ob.obfs = { type = q.obfs }
			local opw = q["obfs-password"] or q.obfs_password
			if opw and opw ~= "" then ob.obfs.password = opw end
		end
		if q.up   and q.up   ~= "" then ob.up_mbps   = tonumber(q.up)   end
		if q.down and q.down ~= "" then ob.down_mbps = tonumber(q.down) end
		-- A link carries the hopping range but no interval, so sing-box
		-- hops at its own default (30s, sing-quic's defaultHopInterval).
		ob.server_ports = hy2_server_ports(q.mport)
		return ob
	end

	if scheme == "tuic" then
		local u, pw = split_userinfo(userinfo)
		local ob = {
			type = "tuic", tag = tag, server = h, server_port = p or 0,
			uuid     = u  or "",
			password = pw or ""
		}
		if q.congestion_control and q.congestion_control ~= "" then
			ob.congestion_control = q.congestion_control
		end
		if q.udp_relay_mode and q.udp_relay_mode ~= "" then
			ob.udp_relay_mode = q.udp_relay_mode
		end
		local tls = build_tls_from_query(force_tls(q))
		if tls then ob.tls = tls end
		return ob
	end

	if scheme == "anytls" then
		local ob = {
			type = "anytls", tag = tag, server = h, server_port = p or 0,
			password = url_decode(userinfo)
		}
		local tls = build_tls_from_query(force_tls(q))
		if tls then ob.tls = tls end
		return ob
	end

	if scheme == "socks5" or scheme == "socks" then
		local user, pwd = split_userinfo(userinfo)
		local ob = {
			type = "socks", tag = tag, server = h, server_port = p or 0,
			version = "5"
		}
		if user and user ~= "" then ob.username = user end
		if pwd  and pwd  ~= "" then ob.password = pwd  end
		return ob
	end

	return nil
end

-- Map a parsed outbound onto the node editor's UCI fields — the inverse of
-- build-config's build_node_from_uci. Returns the fields plus the names of
-- the link's settings the editor has no field for, so the UI can say what
-- did not carry over instead of dropping it silently.
local function outbound_to_uci(ob)
	-- A value is a string, or an array for a UCI list option (tls_alpn,
	-- hy2_server_ports).
	local f, dropped = {}, {}
	local function put(k, v)
		if v ~= nil and v ~= "" then f[k] = tostring(v) end
	end
	local function drop(name) dropped[#dropped + 1] = name end

	put("type", ob.type);  put("tag", ob.tag)
	put("server", ob.server)
	if (tonumber(ob.server_port) or 0) > 0 then put("server_port", ob.server_port) end
	put("uuid", ob.uuid);  put("password", ob.password)
	put("flow", ob.flow);  put("method", ob.method)
	put("username", ob.username)
	put("packet_encoding", ob.packet_encoding)
	if ob.udp_over_tcp == true or (type(ob.udp_over_tcp) == "table" and ob.udp_over_tcp.enabled) then
		f.udp_over_tcp = "1"
	end
	if ob.type == "vmess" then
		put("security", ob.security)
		if (tonumber(ob.alter_id) or 0) > 0 then put("alter_id", ob.alter_id) end
	end
	put("congestion_control", ob.congestion_control)
	put("udp_relay_mode", ob.udp_relay_mode)
	if type(ob.obfs) == "table" then
		put("obfs_type", ob.obfs.type);  put("obfs_password", ob.obfs.password)
	end
	if type(ob.server_ports) == "table" and #ob.server_ports > 0 then
		f.hy2_server_ports = ob.server_ports
		put("hy2_hop_interval", ob.hop_interval)
	end
	put("hy2_up_mbps", ob.up_mbps);  put("hy2_down_mbps", ob.down_mbps)

	local tls = ob.tls
	if type(tls) == "table" and tls.enabled then
		if ob.type == "vless" or ob.type == "vmess" then f.tls_enabled = "1" end
		put("tls_sni", tls.server_name)
		if tls.insecure then f.tls_insecure = "1" end
		if type(tls.utls) == "table" then put("tls_fingerprint", tls.utls.fingerprint) end
		if type(tls.reality) == "table" and tls.reality.enabled then
			f.tls_reality = "1"
			put("tls_reality_public_key", tls.reality.public_key)
			put("tls_reality_short_id", tls.reality.short_id)
		end
		if type(tls.alpn) == "table" and #tls.alpn > 0 then f.tls_alpn = tls.alpn end
		put("tls_min_version", tls.min_version);  put("tls_max_version", tls.max_version)
		if type(tls.ech) == "table" and tls.ech.enabled then
			f.tls_ech = "1"
			if type(tls.ech.config) == "table" then
				put("tls_ech_config", table.concat(tls.ech.config, "\n"))
			end
		end
	end

	local tr = ob.transport
	if type(tr) == "table" then
		if tr._xhttp then
			f.transport_type = "xhttp"
			put("transport_xhttp_path", tr.path)
			put("transport_xhttp_host", type(tr.host) == "table" and tr.host[1] or tr.host)
		elseif tr.type == "ws" then
			f.transport_type = "ws"
			put("transport_ws_path", tr.path)
			put("transport_ws_host", type(tr.headers) == "table" and tr.headers.Host or nil)
			put("transport_ws_max_early_data", tr.max_early_data)
			put("transport_ws_early_data_header", tr.early_data_header_name)
		elseif tr.type == "grpc" then
			f.transport_type = "grpc"
			put("transport_grpc_service", tr.service_name)
		elseif tr.type == "http" then
			f.transport_type = "http"
			put("transport_http_path", tr.path)
			put("transport_http_host", type(tr.host) == "table" and table.concat(tr.host, ",") or tr.host)
		elseif tr.type == "httpupgrade" then
			f.transport_type = "httpupgrade"
			put("transport_httpupgrade_path", tr.path)
			put("transport_httpupgrade_host", tr.host)
		else
			drop(tostring(tr.type) .. " transport")
		end
	end
	return f, dropped
end

-- ─── Clash YAML helpers ──────────────────────────────────────────────────────
-- Clash subscriptions list each proxy either as an inline flow mapping —
--   - { name: 'X Y', type: anytls, alpn: [h2, http/1.1], password: '...', ... }
-- — or as block-style nested keys. The flow form needs a parser that handles
-- quoted scalars (which can contain commas and spaces), [...] arrays, and
-- nested {...} maps; a naive key:value gmatch stops at the first whitespace
-- inside a quoted name and truncates fields like '🇭🇰 HK1' to '🇭🇰'.

-- Encode a Unicode code point as UTF-8 bytes. Lua 5.1 has no utf8 library
-- and node names routinely carry non-BMP characters (flag emoji are
-- regional-indicator pairs in the U+1F1E6-U+1F1FF range, 4-byte UTF-8).
local function utf8_encode(cp)
	if cp < 0x80 then
		return string.char(cp)
	elseif cp < 0x800 then
		return string.char(0xC0 + math.floor(cp / 0x40),
		                    0x80 + (cp % 0x40))
	elseif cp < 0x10000 then
		return string.char(0xE0 + math.floor(cp / 0x1000),
		                    0x80 + (math.floor(cp / 0x40) % 0x40),
		                    0x80 + (cp % 0x40))
	else
		return string.char(0xF0 + math.floor(cp / 0x40000),
		                    0x80 + (math.floor(cp / 0x1000) % 0x40),
		                    0x80 + (math.floor(cp / 0x40) % 0x40),
		                    0x80 + (cp % 0x40))
	end
end

-- Single-character YAML double-quoted escapes (YAML 1.1/1.2 core schema),
-- keyed by the character following the backslash.
local YAML_SHORT_ESCAPES = {
	["0"] = "\0",         a = "\7",  b = "\8",   t = "\9",
	n     = "\10",  v = "\11", f = "\12",  r = "\13",
	e     = "\27",  ["\\"] = "\\", ['"'] = '"', ["/"] = "/",
	N     = utf8_encode(0x85),   ["_"] = utf8_encode(0xA0),
	L     = utf8_encode(0x2028), P = utf8_encode(0x2029),
}

-- Decode YAML backslash escapes inside a double-quoted scalar's raw content
-- (outer quotes already stripped). \xXX / \uXXXX / \UXXXXXXXX are hex code
-- point escapes; everything else is a single-character escape or, for an
-- unrecognised backslash sequence, the escaped character verbatim.
local function decode_dq_escapes(s)
	local out, j, n = {}, 1, #s
	while j <= n do
		local c = s:sub(j, j)
		if c == "\\" and j < n then
			local esc = s:sub(j + 1, j + 1)
			if esc == "x" then
				out[#out + 1] = utf8_encode(tonumber(s:sub(j + 2, j + 3), 16) or 0)
				j = j + 4
			elseif esc == "u" then
				out[#out + 1] = utf8_encode(tonumber(s:sub(j + 2, j + 5), 16) or 0)
				j = j + 6
			elseif esc == "U" then
				out[#out + 1] = utf8_encode(tonumber(s:sub(j + 2, j + 9), 16) or 0)
				j = j + 10
			else
				out[#out + 1] = YAML_SHORT_ESCAPES[esc] or esc
				j = j + 2
			end
		else
			out[#out + 1] = c
			j = j + 1
		end
	end
	return table.concat(out)
end

local function clash_read_quoted(s, i)
	local q = s:sub(i, i)
	if q ~= "'" and q ~= '"' then return nil, i end
	local j = i + 1
	local out = {}
	while j <= #s do
		local c = s:sub(j, j)
		if c == q then
			-- '' inside a single-quoted scalar is an escaped single quote.
			if q == "'" and s:sub(j + 1, j + 1) == "'" then
				out[#out + 1] = "'"
				j = j + 2
			else
				local content = table.concat(out)
				if q == '"' then content = decode_dq_escapes(content) end
				return content, j + 1
			end
		elseif q == '"' and c == "\\" then
			-- Keep the escape sequence's backslash+marker verbatim; the hex
			-- digits that may follow (for \x/\u/\U) are plain characters
			-- and fall through to the else branch untouched. decode_dq_escapes
			-- interprets the whole thing once the closing quote is found.
			out[#out + 1] = c
			out[#out + 1] = s:sub(j + 1, j + 1)
			j = j + 2
		else
			out[#out + 1] = c
			j = j + 1
		end
	end
	local content = table.concat(out)
	if q == '"' then content = decode_dq_escapes(content) end
	return content, j
end

local function clash_read_value(s, i)
	while i <= #s and s:sub(i, i):match("[ \t]") do i = i + 1 end
	local c = s:sub(i, i)
	if c == "'" or c == '"' then
		return clash_read_quoted(s, i)
	elseif c == "[" or c == "{" then
		local close = (c == "[") and "]" or "}"
		local depth, j = 0, i
		while j <= #s do
			local ch = s:sub(j, j)
			if ch == c then
				depth = depth + 1
			elseif ch == close then
				depth = depth - 1
				if depth == 0 then return s:sub(i, j), j + 1 end
			elseif ch == "'" or ch == '"' then
				local _, k = clash_read_quoted(s, j)
				j = k - 1
			end
			j = j + 1
		end
		return s:sub(i), j
	else
		local j = i
		while j <= #s do
			local ch = s:sub(j, j)
			if ch == "," or ch == "}" or ch == "\n" then break end
			j = j + 1
		end
		return s:sub(i, j - 1):match("^%s*(.-)%s*$"), j
	end
end

-- Parse the body of a YAML flow mapping (the text between the outer { }).
local function clash_parse_flow(s)
	local fields = {}
	local i = 1
	while i <= #s do
		while i <= #s and s:sub(i, i):match("[ \t,]") do i = i + 1 end
		if i > #s or s:sub(i, i) == "}" then break end
		local k_start = i
		while i <= #s and s:sub(i, i) ~= ":" and s:sub(i, i) ~= "}" do
			i = i + 1
		end
		local key = s:sub(k_start, i - 1):match("^%s*(.-)%s*$")
		if s:sub(i, i) ~= ":" then break end
		i = i + 1
		local val, ni = clash_read_value(s, i)
		i = ni
		if key ~= "" then fields[key] = val end
	end
	return fields
end

local function clash_parse_list(raw)
	if not raw or raw == "" then return nil end
	local body = raw:match("^%[(.*)%]$")
	if not body then return nil end
	local out = {}
	local i = 1
	while i <= #body do
		while i <= #body and body:sub(i, i):match("[ \t,]") do i = i + 1 end
		if i > #body then break end
		local v, ni = clash_read_value(body, i)
		if v and v ~= "" then out[#out + 1] = v end
		i = ni
	end
	if #out == 0 then return nil end
	return out
end

local function clash_truthy(v)
	if type(v) == "boolean" then return v end
	if type(v) ~= "string"  then return false end
	v = v:lower()
	return v == "true" or v == "yes" or v == "1"
end

-- Build the sing-box `transport` sub-block from a Clash entry's `network`
-- plus its matching `<net>-opts` mapping (already stored under dotted keys
-- by extract_clash). Returns:
--   nil, nil     — no transport (plain tcp), the common case
--   table, nil   — the transport block
--   nil, reason  — the entry asks for a transport sing-box cannot dial
local function build_clash_transport(fields)
	local net = (fields["network"] or ""):lower()
	if net == "" or net == "tcp" or net == "raw" then return nil, nil end
	-- mihomo ships XHTTP as `network: xhttp` plus an `xhttp-opts` mapping.
	-- stream-one maps onto sing-box's `http` transport; other modes do not.
	if net == "xhttp" then
		return lib.map_xhttp_transport(fields["xhttp-opts.path"],
			fields["xhttp-opts.host"], fields["xhttp-opts.mode"])
	end
	if not lib.SUPPORTED_TRANSPORTS[net] and net ~= "h2" then
		return nil, "transport '" .. net .. "' is not supported by sing-box"
	end

	if net == "ws" then
		local tr = { type = "ws" }
		local path = fields["ws-opts.path"]
		if path and path ~= "" then tr.path = path end
		local host = fields["ws-opts.headers.Host"] or fields["ws-opts.headers.host"]
		if host and host ~= "" then tr.headers = { Host = host } end
		local med = tonumber(fields["ws-opts.max-early-data"])
		if med then tr.max_early_data = med end
		local edh = fields["ws-opts.early-data-header-name"]
		if edh and edh ~= "" then tr.early_data_header_name = edh end
		-- mihomo spells httpupgrade as a ws-opts flag rather than its own
		-- network value; sing-box has it as a distinct transport type.
		if clash_truthy(fields["ws-opts.v2ray-http-upgrade"]) then
			tr.type = "httpupgrade"
			tr.headers, tr.max_early_data, tr.early_data_header_name = nil, nil, nil
			if host and host ~= "" then tr.host = host end
		end
		return tr, nil
	end

	if net == "grpc" then
		local tr = { type = "grpc" }
		local sn = fields["grpc-opts.grpc-service-name"] or fields["grpc-opts.service-name"]
		if sn and sn ~= "" then tr.service_name = sn end
		return tr, nil
	end

	if net == "http" or net == "h2" then
		local tr = { type = "http" }
		local prefix = (net == "h2") and "h2-opts." or "http-opts."
		local path = fields[prefix .. "path"]
		if path and path ~= "" then tr.path = path end
		local hosts = clash_parse_list(fields[prefix .. "host"])
		if hosts then
			tr.host = hosts
		else
			local h = fields[prefix .. "host"]
			if h and h ~= "" then tr.host = { h } end
		end
		return tr, nil
	end

	if net == "httpupgrade" then
		local tr = { type = "httpupgrade" }
		local path = fields["ws-opts.path"] or fields["httpupgrade-opts.path"]
		if path and path ~= "" then tr.path = path end
		local host = fields["ws-opts.headers.Host"] or fields["httpupgrade-opts.host"]
		if host and host ~= "" then tr.host = host end
		return tr, nil
	end

	-- quic: sing-box takes an options-less transport block.
	return { type = net }, nil
end

-- Map a Clash proxy fields table to a sing-box outbound table.
-- Returns nil when the entry lacks the minimum required keys (name/type/server),
-- or nil plus a "<tag>: <reason>" string when the entry is well-formed but
-- describes something sing-box cannot dial — the caller logs those so a node
-- vanishing from the list is explainable.
local function build_clash_outbound(fields)
	local nm  = fields["name"]
	local srv = fields["server"]
	local typ = fields["type"]
	if not nm or nm == "" or not srv or srv == "" or not typ or typ == "" then
		return nil
	end
	if typ == "ss"  then typ = "shadowsocks" end
	if typ == "hy2" then typ = "hysteria2"  end

	local ob = {
		type        = typ,
		tag         = nm,
		server      = srv,
		server_port = tonumber(fields["port"]) or 0
	}

	-- Protocols whose wire format is always TLS. Used to enable tls when the
	-- Clash entry omits explicit tls/sni/alpn but the protocol requires it.
	local function tls_implicit(t)
		return t == "trojan" or t == "anytls" or t == "hysteria2" or t == "tuic"
	end
	local function apply_tls()
		local sni    = fields["sni"] or fields["servername"]
		local alpn   = clash_parse_list(fields["alpn"])
		local cfp    = fields["client-fingerprint"]
		local insec  = clash_truthy(fields["skip-cert-verify"])
		-- REALITY is always TLS, and providers routinely ship the node with
		-- no `tls: true` alongside it — the reality-opts block IS the
		-- indicator. Without this the whole tls block was omitted and the
		-- handshake failed with no diagnostic at all.
		local pbk    = fields["reality-opts.public-key"]
		local indic  = sni or alpn or cfp or insec or pbk or clash_truthy(fields["tls"])
		if not (indic or tls_implicit(typ)) then return end
		ob.tls = { enabled = true }
		if sni and sni ~= "" then ob.tls.server_name = sni end
		if alpn               then ob.tls.alpn        = alpn end
		if insec              then ob.tls.insecure    = true end
		if cfp and cfp ~= "" then
			ob.tls.utls = { enabled = true, fingerprint = cfp }
		end
		if pbk and pbk ~= "" then
			ob.tls.reality = { enabled = true, public_key = pbk }
			local sid = fields["reality-opts.short-id"]
			if sid and sid ~= "" then ob.tls.reality.short_id = sid end
		end
	end

	if typ == "anytls" or typ == "trojan" then
		ob.password = fields["password"] or ""
		apply_tls()
	elseif typ == "vless" then
		ob.uuid = fields["uuid"] or ""
		if fields["flow"] and fields["flow"] ~= "" then ob.flow = fields["flow"] end
		apply_tls()
	elseif typ == "vmess" then
		ob.uuid     = fields["uuid"] or ""
		ob.alter_id = tonumber(fields["alterId"]) or 0
		ob.security = fields["cipher"] or "auto"
		apply_tls()
	elseif typ == "hysteria2" then
		ob.password = fields["password"] or fields["auth"] or ""
		apply_tls()
		local obfs = fields["obfs"]
		if obfs and obfs ~= "" then
			ob.obfs = { type = obfs }
			local opw = fields["obfs-password"]
			if opw and opw ~= "" then ob.obfs.password = opw end
		end
		if fields["up"]   then ob.up_mbps   = tonumber(fields["up"])   end
		if fields["down"] then ob.down_mbps = tonumber(fields["down"]) end
		-- Port hopping; Clash writes `hop-interval` in whole seconds.
		ob.server_ports = hy2_server_ports(fields["ports"])
		if ob.server_ports then
			local hop = tonumber(fields["hop-interval"])
			if hop and hop > 0 then ob.hop_interval = math.floor(hop) .. "s" end
		end
	elseif typ == "tuic" then
		ob.uuid     = fields["uuid"]     or ""
		ob.password = fields["password"] or ""
		if fields["congestion-control"] then ob.congestion_control = fields["congestion-control"] end
		if fields["udp-relay-mode"]     then ob.udp_relay_mode     = fields["udp-relay-mode"]     end
		apply_tls()
	elseif typ == "shadowsocks" then
		ob.method   = fields["cipher"]   or ""
		ob.password = fields["password"] or ""
	elseif typ == "socks5" or typ == "socks" then
		ob.type    = "socks"
		ob.version = "5"
		if fields["username"] then ob.username = fields["username"] end
		if fields["password"] then ob.password = fields["password"] end
	end

	-- Transport last, and only for the V2Ray-family protocols that carry
	-- one — the same set parse_proxy_uri builds a transport for. Elsewhere
	-- Clash's `network` key means something else entirely (udp/tcp
	-- selection), so it must not be read as a transport.
	--
	-- A transport sing-box cannot dial rejects the whole node: building it
	-- without the transport yields a plausible-looking outbound that is
	-- selectable, testable, and fails every handshake.
	if typ == "vless" or typ == "vmess" or typ == "trojan" then
		local tr, reject = build_clash_transport(fields)
		if reject then
			return nil, nm .. ": " .. reject
		end
		if tr then ob.transport = tr end
	end

	return ob, nil
end

-- ─── node extraction ─────────────────────────────────────────────────────
-- Each extractor turns one subscription format into a flat list of
-- { tag, type, server, server_port, payload } node tables. parse_subscription
-- routes a body to exactly one extractor, so the body is parsed a single time.

-- Reserved tags are dropped at parse time so they never reach the nodes
-- JSON or list_subscription_nodes; build-config drops them again at
-- emission time. One shared table in treadlelib keeps the filters in step.
local RESERVED_TAGS = lib.RESERVED_TAGS

-- SingBox JSON: the outbounds array, minus builtin and group outbounds.
-- lib.ALLOWED_PROTOCOLS is the same whitelist build-config's sanitiser
-- enforces; applying it here too means an unsupported type (notably `ssh`,
-- `tor`, or a future sing-box outbound that takes a filesystem path
-- argument) is rejected at parse time and never written to
-- /etc/treadle/nodes/*.json.
local function extract_singbox(body)
	local nodes, skipped = {}, {}
	local ok, cfg = pcall(_jsonc.parse, body)
	if not ok or not cfg or type(cfg.outbounds) ~= "table" then return nodes, skipped end
	for _, ob in ipairs(cfg.outbounds) do
		if type(ob) == "table" and ob.tag and lib.ALLOWED_PROTOCOLS[ob.type]
		   and not RESERVED_TAGS[ob.tag]
		   and not ob.tag:find("[%c]") then
			-- A sing-box-format subscription can name a transport this
			-- sing-box has no dialer for just as a Clash one can; reject
			-- the node rather than import an outbound that cannot connect.
			local ttype = type(ob.transport) == "table" and ob.transport.type or nil
			-- An xhttp block here maps onto `http` exactly as it does in the
			-- other two formats; rewrite it in place before the payload is
			-- stringified so the stored node is already dialable.
			local xreason
			if ttype == "xhttp" then
				local tr
				tr, xreason = lib.map_xhttp_transport(ob.transport.path,
					ob.transport.host, ob.transport.mode)
				if tr then ob.transport, ttype = tr, "http" end
			end
			if xreason then
				skipped[#skipped + 1] = ob.tag .. ": " .. xreason
			elseif ttype and ttype ~= "" and not lib.SUPPORTED_TRANSPORTS[ttype] then
				skipped[#skipped + 1] = ob.tag .. ": transport '" .. tostring(ttype)
					.. "' is not supported by sing-box"
			else
				nodes[#nodes + 1] = {
					tag         = ob.tag,
					type        = ob.type or "",
					server      = ob.server and tostring(ob.server) or "",
					server_port = tonumber(ob.server_port) or 0,
					payload     = _jsonc.stringify(ob)
				}
			end
		end
	end
	return nodes, skipped
end

-- Strip optional surrounding quotes from a whole-line-captured scalar value
-- (block-style "key: value" lines, already sliced out by the caller's line
-- regex) and decode double-quoted escapes. This does its own quote match
-- rather than reusing clash_read_quoted because the value is already a
-- complete, isolated slice with no need to hunt for the terminating quote.
local function unquote_scalar(v)
	local dq = v:match('^"(.*)"$')
	if dq then return decode_dq_escapes(dq) end
	local sq = v:match("^'(.*)'$")
	if sq then return (sq:gsub("''", "'")) end
	return v
end

-- Clash YAML: the proxies: list, in inline-flow or block style.
--
-- Sequence items under `proxies:` are valid YAML at *any* indentation,
-- including flush with the key itself ("proxies:\n- name: ..."), which is
-- what several real-world subscription generators emit. The indentation of
-- the first entry dash seen is recorded as `entry_indent`; only dash lines
-- at exactly that indentation start a new proxy. A dash line indented
-- *deeper* than that (e.g. "  - h2" under a block-style "alpn:" list) is a
-- nested list item, not a new proxy — its value is appended to the pending
-- list field instead of flushing the entry early.
local function extract_clash(body)
	local nodes, skipped = {}, {}
	local in_proxies, fields = false, {}
	local entry_indent = nil
	local list_key, list_items = nil, nil
	-- Open block-style nested mappings ("ws-opts:" with its keys on the
	-- following, deeper-indented lines), innermost last. Each frame carries
	-- the dotted prefix its keys are stored under and the indentation of the
	-- line that opened it. A line pops every frame at or above its own
	-- indent, so returning from "ws-opts.headers" to a sibling of "path"
	-- lands back in "ws-opts" rather than at the top level.
	local nest = {}

	local function close_list()
		if list_key and list_items and #list_items > 0 then
			fields[list_key] = "[" .. table.concat(list_items, ", ") .. "]"
		end
		list_key, list_items = nil, nil
	end

	local function flush()
		close_list()
		local ob, reject = build_clash_outbound(fields)
		if ob and (RESERVED_TAGS[ob.tag] or ob.tag:find("[%c]")) then ob = nil end
		if reject then
			skipped[#skipped + 1] = reject
		end
		if ob then
			local payload = _jsonc.stringify(ob)
			nodes[#nodes + 1] = {
				tag         = ob.tag,
				type        = ob.type,
				server      = ob.server,
				server_port = ob.server_port,
				payload     = payload
			}
		end
		fields = {}
		nest = {}
	end

	-- Expand an inline flow mapping into `fields`. clash_read_value hands
	-- back a nested flow mapping as its literal "{...}" text, so recurse
	-- into those under a dotted prefix — flow and block style then produce
	-- exactly the same keys.
	local function expand_flow(prefix, body_text)
		for k, v in pairs(clash_parse_flow(body_text)) do
			local key   = prefix and (prefix .. "." .. k) or k
			local inner = type(v) == "string" and v:match("^{(.*)}$")
			if inner then
				expand_flow(key, inner)
			else
				fields[key] = v
			end
		end
	end

	-- Store a parsed "key: value" pair. An empty value (e.g. "alpn:" with
	-- the list on following lines, or "ws-opts:" with a nested mapping)
	-- opens a pending block instead of setting the field directly: which
	-- kind it turns out to be is decided by the next deeper-indented line —
	-- a dash makes it a list, a "k: v" pair makes it a mapping.
	--
	-- Nested mapping keys are stored dotted ("ws-opts.headers.Host"), not
	-- flattened onto the top level. Flattening lost which block a key came
	-- from, so `path` under ws-opts and under h2-opts were the same field
	-- and nothing could read either one back reliably.
	local function set_field(k, v, indent)
		if indent then
			while #nest > 0 and indent <= nest[#nest].indent do
				table.remove(nest)
			end
		else
			nest = {}
		end
		local key = (#nest > 0) and (nest[#nest].key .. "." .. k) or k
		if v == "" then
			close_list()
			list_key, list_items = key, nil
			if indent then nest[#nest + 1] = { key = key, indent = indent } end
		elseif not fields[key] then
			close_list()
			fields[key] = unquote_scalar(v)
		end
	end

	for line in (body .. "\n"):gmatch("([^\n]*)\n") do
		if line:match("^proxies%s*:") then
			in_proxies = true
			entry_indent = nil
		elseif in_proxies then
			local indent  = #line:match("^(%s*)")
			local is_dash = line:match("^%s*%-")

			if is_dash and entry_indent and indent > entry_indent then
				-- Nested block-style list item under the pending list_key.
				local v = line:match("^%s*%-%s*(.-)%s*$")
				if list_key and v and v ~= "" then
					list_items = list_items or {}
					list_items[#list_items + 1] = v
				end
			elseif is_dash then
				flush()
				entry_indent = entry_indent or indent
				-- Inline flow form: "  - { name: 'X', type: T, ... }"
				local inline = line:match("^%s*%-%s*{(.+)}%s*$")
				if inline then
					expand_flow(nil, inline)
				else
					-- Block-style dash with first key on the same line.
					local k, v = line:match("^%s*%-%s*([%a][%w%-_]*)%s*:%s*(.-)%s*$")
					if k then set_field(k, v, indent) end
				end
			elseif line:match("^%S") then
				flush(); in_proxies = false
			else
				local k, v = line:match("^%s+([%a][%w%-_]*)%s*:%s*(.-)%s*$")
				if k then set_field(k, v, indent) end
			end
		end
	end
	flush()
	return nodes, skipped
end

-- Plain or Base64-decoded URI list: one proxy:// URI per line.
local function extract_uris(text)
	local nodes, skipped = {}, {}
	for line in (text .. "\n"):gmatch("([^\n]*)\n") do
		local ob, reject = parse_proxy_uri(line)
		if reject then skipped[#skipped + 1] = reject end
		if ob and ob.server ~= "" and not RESERVED_TAGS[ob.tag]
		   and not ob.tag:find("[%c]") then
			-- Keep the full sing-box outbound as the payload — that's what
			-- build-config later splices verbatim into route.outbounds.
			nodes[#nodes + 1] = {
				tag         = ob.tag,
				type        = ob.type,
				server      = ob.server,
				server_port = ob.server_port,
				payload     = _jsonc.stringify(ob)
			}
		end
	end
	return nodes, skipped
end

-- Identify a subscription's format and extract its nodes in a single pass.
-- The format is just "which parser succeeded": a cheap pre-check (first
-- character, a proxies: line, the base64 alphabet) routes the body to one
-- extractor, which then runs exactly once. Returns the format string, the
-- node list, and a list of "<tag>: <reason>" strings for entries that parsed
-- but describe something sing-box cannot dial (see build_clash_transport).
-- Order: SingBox JSON → Clash YAML → Base64 URI list → plain URI.
local function parse_subscription(body)
	if not body or body == "" then return "unknown", {} end
	local trimmed = body:match("^%s*(.-)%s*$")
	if trimmed == "" then return "unknown", {} end

	-- SingBox JSON: root object starts with {, possibly after leading
	-- comments — some providers prepend a `// traffic / expiry` banner.
	local head = trimmed
	repeat
		local prev = head
		head = head:gsub("^//[^\n]*%s*", "", 1):gsub("^/%*.-%*/%s*", "", 1)
	until head == prev
	if head:sub(1, 1) == "{" then
		return "singbox", extract_singbox(head)
	end

	-- Clash YAML: proxies: appears as an unindented top-level key
	if trimmed:find("^proxies:") or trimmed:find("\nproxies:") then
		return "clash", extract_clash(trimmed)
	end

	-- Base64-encoded URI list: content is entirely base64 alphabet
	-- characters. A plain URI list can never pass this check (every URI
	-- contains ':'), so a match IS base64 — return even with 0 nodes so a
	-- failed parse is logged as format=base64 rather than unknown.
	local stripped = trimmed:gsub("%s", "")
	if #stripped >= 16 and stripped:match("^[A-Za-z0-9+/%-_=]+$") then
		return "base64", extract_uris(base64_decode(stripped))
	end

	-- Plain URI list
	local nodes, skipped = extract_uris(trimmed)
	return (#nodes > 0 and "uri-list" or "unknown"), nodes, skipped
end

return {
	parse_proxy_uri    = parse_proxy_uri,
	outbound_to_uci    = outbound_to_uci,
	parse_subscription = parse_subscription,
}
