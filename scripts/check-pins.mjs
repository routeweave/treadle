// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave
//
// Compare the versions pinned by hand, which Dependabot cannot see, with
// what upstream has released. weekly.yml runs it and keeps one issue up to
// date with the result.
//
//   node scripts/check-pins.mjs [--report <file>]
//
// Exits 0 when every pin is current, 1 when one is behind (the report, in
// Markdown, says what to change), 2 when upstream could not be asked.
//
// Pins:
//   SINGBOX_UPSTREAM_VERSION (+ its SHA-256), PLAYWRIGHT_VERSION,
//   SHELLCHECK_VERSION (+ its SHA-256)      .github/workflows/test.yml
//   ESLINT_VERSION                           scripts/lint.sh
//   the OpenWrt point releases tested        test.yml, test-images.yml

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const TEST = '.github/workflows/test.yml';
const LINT = 'scripts/lint.sh';

const pin = (file, name) => {
	const m = read(file).match(new RegExp(`^\\s*${name}[:=]\\s*['"]?([^'"\\s#]+)`, 'm'));
	if (!m)
		throw new Error(`${file}: no ${name}`);
	return m[1];
};

async function getJSON(url) {
	const headers = { 'User-Agent': 'treadle-check-pins', Accept: 'application/json' };
	if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN)
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const r = await fetch(url, { headers });
	if (!r.ok)
		throw new Error(`${url}: HTTP ${r.status}`);
	return r.json();
}

const newer = (a, b) => {   // true when version b is newer than a
	const pa = a.replace(/^v/, '').split('.').map(Number);
	const pb = b.replace(/^v/, '').split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++)
		if ((pb[i] || 0) !== (pa[i] || 0))
			return (pb[i] || 0) > (pa[i] || 0);
	return false;
};

const behind = [];
const current = [];
function compare(what, pinned, latest, where, extra = '') {
	if (newer(pinned, latest))
		behind.push(`| ${what} | ${pinned} | **${latest}** | ${where}${extra ? `<br>${extra}` : ''} |`);
	else
		current.push(`${what} ${pinned}`);
}

async function githubRelease(repo, assetName) {
	const rel = await getJSON(`https://api.github.com/repos/${repo}/releases/latest`);
	const asset = assetName && rel.assets.find(a => a.name === assetName(rel.tag_name.replace(/^v/, '')));
	return { version: rel.tag_name.replace(/^v/, ''), digest: asset?.digest?.replace(/^sha256:/, '') };
}

try {
	// sing-box: the linux-amd64-musl tarball the upstream smoke job unpacks.
	const sb = await githubRelease('SagerNet/sing-box', v => `sing-box-${v}-linux-amd64-musl.tar.gz`);
	compare('sing-box (upstream smoke job)', pin(TEST, 'SINGBOX_UPSTREAM_VERSION'), sb.version, `\`${TEST}\``,
		sb.digest ? `with \`SINGBOX_UPSTREAM_SHA256: ${sb.digest}\`` : 'with the tarball\'s SHA-256');

	const sc = await githubRelease('koalaman/shellcheck', v => `shellcheck-v${v}.linux.x86_64.tar.xz`);
	compare('shellcheck', pin(TEST, 'SHELLCHECK_VERSION'), sc.version, `\`${TEST}\``,
		sc.digest ? `with \`SHELLCHECK_SHA256: ${sc.digest}\`` : 'with the tarball\'s SHA-256');

	for (const [ pkg, file, name ] of [ [ 'playwright', TEST, 'PLAYWRIGHT_VERSION' ], [ 'eslint', LINT, 'ESLINT_VERSION' ] ]) {
		const latest = (await getJSON(`https://registry.npmjs.org/${pkg}/latest`)).version;
		compare(pkg, pin(file, name), latest, `\`${file}\``);
	}

	// OpenWrt: each tested release series against its newest point release,
	// in the tag spelling the matrix already uses.
	const hub = await getJSON('https://hub.docker.com/v2/repositories/openwrt/rootfs/tags?page_size=100&name=x86_64-');
	const tags = hub.results.map(t => t.name);
	const tested = [ ...read(TEST).matchAll(/openwrt\/rootfs:(x86_64-v?)(\d+\.\d+)\.(\d+)/g) ];
	for (const [ , prefix, series ] of new Map(tested.map(m => [ m[2], m ])).values()) {
		const pinned = tested.filter(m => m[2] === series).map(m => `${series}.${m[3]}`)[0];
		const points = tags.map(t => t.match(new RegExp(`^${prefix}${series.replace('.', '\\.')}\\.(\\d+)$`)))
			.filter(Boolean).map(m => `${series}.${m[1]}`);
		const latest = points.reduce((a, b) => (newer(a, b) ? b : a), pinned);
		compare('OpenWrt', pinned, latest,
			'`test.yml` and `test-images.yml` (`openwrt/rootfs:' + prefix + series + '.N`)');
	}
} catch (e) {
	console.error(`check-pins: ${e.message}`);
	process.exit(2);
}

const report = behind.length ? [
	'These versions are pinned by hand and Dependabot does not track them. Newer releases are out:',
	'',
	'| Pin | Pinned | Latest | Where |',
	'|---|---|---|---|',
	...behind,
	'',
	`Current: ${current.join(', ') || 'none'}.`,
	'',
	'Updated weekly by `weekly.yml` (`scripts/check-pins.mjs`); closed once every pin is current.',
].join('\n') : `Every pin is current: ${current.join(', ')}.`;

console.log(report);
const out = process.argv.indexOf('--report');
if (out > 0)
	writeFileSync(process.argv[out + 1], report + '\n');
process.exit(behind.length ? 1 : 0);
