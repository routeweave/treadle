// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave
//
// Privacy gate: nothing from a real subscription, network or person goes
// into the public repository (CONTRIBUTING.md § Commits). It finds what
// the placeholder rules forbid and lets through what they allow, so that it
// can fail a push rather than print a list for a human to read.
//
//   node scripts/privacy-check.mjs range <base> <head>
//       the lines a range of commits adds, the commits' messages, and their
//       identities and dates (the pre-push hook and CI)
//   node scripts/privacy-check.mjs text <label> < file
//       free text, such as a pull request's title and body (CI)
//   node scripts/privacy-check.mjs tree
//       every tracked file
//
// Flags: share links and subscription URLs to a host that is not a
// placeholder, IPv4 addresses outside the documentation ranges and known
// defaults, non-zero UUIDs, quoted credential values, long mixed-case
// base64 runs, e-mail addresses outside the placeholder domains, and in a
// range, a commit not made as routeweave or not dated in UTC.
//
// A line that must carry a flagged value for a reason that is not personal
// can say so with the words "privacy-check: allow".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });

// ── what is allowed ─────────────────────────────────────────────────────────
const PLACEHOLDER_HOST = /^(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.invalid|localhost)$/i;
const ALLOWED_EMAIL = /@(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com|github\.com)$/i;
const IDENTITIES = new Set([
	'routeweave <287117316+routeweave@users.noreply.github.com>',
	'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
]);

function octets(ip) { return ip.split('.').map(Number); }
function inNet(ip, net, bits) {
	const a = octets(ip), b = octets(net);
	const n = (x) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0;
	const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
	return (n(a) & mask) === (n(b) & mask);
}
// Documentation ranges, loopback, unspecified/broadcast, the OpenWrt default
// LAN, well-known public resolvers, and the defaults the code ships.
const ALLOWED_NETS = [
	[ '192.0.2.0', 24 ], [ '198.51.100.0', 24 ], [ '203.0.113.0', 24 ],
	[ '127.0.0.0', 8 ], [ '192.168.1.0', 24 ],
];
const ALLOWED_IPS = new Set([
	'0.0.0.0', '255.255.255.255', '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4',
	'9.9.9.9', '149.112.112.112',
	'172.19.0.1',  // sing-box's tun address default
	'10.0.0.2',    // the WireGuard address placeholder in the node editor
]);
// Reserved blocks may appear by their network address (firewall and route
// exclusions), never as a host.
const RESERVED = [
	[ '10.0.0.0', 8 ], [ '172.16.0.0', 12 ], [ '192.168.0.0', 16 ],
	[ '169.254.0.0', 16 ], [ '100.64.0.0', 10 ], [ '198.18.0.0', 15 ],
	[ '224.0.0.0', 4 ], [ '240.0.0.0', 4 ], [ '192.0.0.0', 24 ],
	[ '192.88.99.0', 24 ], [ '127.0.0.0', 8 ],
];
function ipAllowed(ip) {
	if (ALLOWED_IPS.has(ip) || ALLOWED_NETS.some(([ n, b ]) => inNet(ip, n, b)))
		return true;
	return RESERVED.some(([ n ]) => n === ip);
}
function hostAllowed(host) {
	host = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host))
		return ipAllowed(host);
	if (host.includes(':'))   // IPv6: only the documentation prefix and loopback
		return /^(2001:db8:|::1$)/.test(host);
	return PLACEHOLDER_HOST.test(host);
}

// ── detectors ───────────────────────────────────────────────────────────────
function b64decode(s) {
	try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
	catch { return ''; }
}

// The host a share link dials, or null when it cannot be told.
function linkHost(scheme, rest) {
	rest = decodeURIComponent(rest.replace(/%(?![0-9a-f]{2})/gi, '%25'));
	if (scheme === 'vmess') {
		const json = b64decode(rest.split(/[?#]/)[0]);
		const m = json.match(/"add"\s*:\s*"([^"]*)"/);
		return m ? m[1] : null;
	}
	let auth = rest.split(/[/?#]/)[0];
	if (!auth.includes('@') && scheme === 'ss')   // ss://base64(method:pass@host:port)
		auth = b64decode(auth);
	const hostport = auth.slice(auth.lastIndexOf('@') + 1);
	const m = hostport.match(/^\[([0-9a-f:]+)\]|^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?$/i);
	// Not a host at all: a scheme named in prose ("vless://, vmess://"), or
	// an ellipsis standing in for a link.
	return m ? (m[1] || m[2]) : null;
}

const SCHEMES = 'vmess|vless|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls|socks5?|wireguard';
const DETECTORS = [
	[ 'share link to a real host', new RegExp(`\\b(${SCHEMES})://([^\\s"'<>\`]+)`, 'gi'), (m) => {
		const host = linkHost(m[1].toLowerCase(), m[2]);
		return host !== null && !hostAllowed(host) ? host : null;
	} ],
	[ 'subscription URL', /https?:\/\/([^\/\s"'<>)`]+)[^\s"'<>)`]*\/(?:sub|link|api\/v1\/client|subscribe)\b/gi,
		(m) => hostAllowed(m[1].split(':')[0]) ? null : m[0] ],
	[ 'IPv4 address', /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g, (m) => {
		const o = octets(m[1]);
		return o.every(x => x <= 255) && !ipAllowed(m[1]) ? m[1] : null;
	} ],
	[ 'UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		(m) => /^[0-]+$/.test(m[0]) ? null : m[0] ],
	// key: "value", key = 'value', and UCI's own `option key 'value'`.
	[ 'credential value', /\b(?:token|secret|passwd|password|private_key|psk|uuid)["']?(?:\s*[:=]\s*|\s+)["']([^"'\s]{4,})["']/gi,
		(m) => /^(?:<[^>]*>|\$\{?|[0-]+$)/.test(m[1]) ? null : m[1] ],
	[ 'base64 payload', /[A-Za-z0-9+\/]{40,}={0,2}/g, (m) => {
		const s = m[0];
		// A hash, a URL path, or the base64 alphabet itself.
		if (/^[0-9a-f]+$/i.test(s) || s.includes('//') || /ABCDEFGHIJ|abcdefghij/.test(s))
			return null;
		const upper = (s.match(/[A-Z]/g) || []).length;
		const lower = (s.match(/[a-z]/g) || []).length;
		const digit = (s.match(/[0-9]/g) || []).length;
		if (upper < 4 || lower < 4 || digit < 4)
			return null;
		// Text inside (an encoded share-link list, say) is judged by what it
		// says; anything else is opaque, and so could be a key or a token.
		const text = b64decode(s);
		const printable = text.replace(/[^\x20-\x7e\n\r\t]/g, '').length;
		if (text.length && printable / text.length > 0.95) {
			const inner = [];
			scan(() => '', text, inner, true);
			return inner.length ? `carrying ${inner[0].replace(/^: /, '')}` : null;
		}
		return s.slice(0, 24) + '…';
	} ],
	[ 'e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		(m) => /^%3C|^0{8}-/.test(m[0]) || ALLOWED_EMAIL.test(m[0]) ? null : m[0] ],
];

function scan(where, text, problems, inner = false) {
	text.split('\n').forEach((line, i) => {
		if (line.includes('privacy-check: allow'))
			return;
		for (const [ what, re, judge ] of DETECTORS)
			for (const m of line.matchAll(re)) {
				if (inner && what === 'base64 payload')
					continue;
				const hit = judge(m);
				if (hit)
					problems.push(`${where(i)}: ${what}: ${hit}`);
			}
	});
}

// Files that are made of keys or digests by design.
const SKIP = /^(?:feed\/keys\/|po\/)|\.(?:png|jpg|ico|gz|apk|ipk)$/;

// ── modes ───────────────────────────────────────────────────────────────────
const [ mode, a, b ] = process.argv.slice(2);
const problems = [];

if (mode === 'range' && a && b) {
	// Added lines, with the file and new line number of each.
	let file = null, line = 0;
	for (const l of git('diff', '-U0', '--no-color', '--no-ext-diff', a, b).split('\n')) {
		if (l.startsWith('+++ ')) { file = l.slice(6); continue; }
		const hunk = l.match(/^@@ -\S+ \+(\d+)/);
		if (hunk) { line = Number(hunk[1]); continue; }
		if (l.startsWith('+') && file && !SKIP.test(file)) {
			scan(() => `${file}:${line}`, l.slice(1), problems);
			line++;
		}
	}
	const SEP = '\u001e';
	for (const rec of git('log', '--no-merges', `--format=%H%n%an <%ae>%n%cn <%ce>%n%ai%n%ci%n%B${SEP}`, `${a}..${b}`).split(SEP)) {
		const [ sha, author, committer, adate, cdate, ...msg ] = rec.trim().split('\n');
		if (!sha)
			continue;
		const c = sha.slice(0, 7);
		for (const id of new Set([ author, committer ]))
			if (!IDENTITIES.has(id))
				problems.push(`commit ${c}: made as ${id}, not routeweave`);
		for (const d of new Set([ adate, cdate ]))
			if (!d.endsWith('+0000'))
				problems.push(`commit ${c}: dated ${d}, not UTC (commit with TZ=UTC0)`);
		scan(() => `commit ${c} message`, msg.join('\n'), problems);
	}
} else if (mode === 'text' && a) {
	scan((i) => `${a}:${i + 1}`, readFileSync(0, 'utf8'), problems);
} else if (mode === 'tree') {
	for (const file of git('ls-files').split('\n').filter(f => f && !SKIP.test(f))) {
		let text;
		try { text = readFileSync(file, 'utf8'); } catch { continue; }
		scan((i) => `${file}:${i + 1}`, text, problems);
	}
} else {
	console.error('usage: privacy-check.mjs range <base> <head> | text <label> | tree');
	process.exit(2);
}

for (const p of problems)
	console.log(p);
console.log(problems.length
	? `${problems.length} possible leak(s): use a placeholder (CONTRIBUTING.md § Commits), or mark a line that is not personal with "privacy-check: allow"`
	: 'privacy check: nothing personal found');
process.exit(problems.length ? 1 : 0);
