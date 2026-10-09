// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave
//
// Browser test: log in to LuCI, open every Treadle tab in headless Chromium,
// and fail on any JS error. Runs on the CI host against the container that
// tests/system.sh has just set up (LuCI and Treadle installed, procd up):
//
//   node browser.mjs http://<container-ip> <screenshot-dir>
//
// The views only run in a browser, so this is the one place a broken
// 'require', a runtime TypeError or a failed RPC in a view shows up before a
// router does. A screenshot of each tab is kept for review.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2];
const out = process.argv[3] || 'screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];

// The login page makes anonymous calls LuCI refuses on purpose, and is
// served with a 403; judge only what happens once logged in.
let loggedIn = false;
page.on('pageerror', e => { if (loggedIn) errors.push(`page error: ${e.message}`); });
page.on('console', m => {
	if (loggedIn && m.type() === 'error')
		errors.push(`console error: ${m.text()} at ${JSON.stringify(m.location())}`);
});
page.on('response', async r => {
	if (!loggedIn)
		return;
	if (r.status() >= 500)
		errors.push(`HTTP ${r.status()}: ${r.url()}`);
	if (r.url().includes('/ubus')) {
		const body = await r.text().catch(() => '');
		if (body.includes('-32002'))
			errors.push(`access denied: ${r.request().postData()}`);
	}
});

const t0 = Date.now();
await page.goto(`${base}/cgi-bin/luci/`);
await page.fill('input[name=luci_username]', 'root');
await page.fill('input[name=luci_password]', '');
await Promise.all([page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter')]);
loggedIn = true;

await page.goto(`${base}/cgi-bin/luci/admin/services/treadle`, { waitUntil: 'networkidle' });
await page.waitForSelector('ul.cbi-tabmenu > li');

const tabs = page.locator('ul.cbi-tabmenu > li');
const n = await tabs.count();
if (n === 0)
	errors.push('no tabs rendered');
for (let i = 0; i < n; i++) {
	const name = (await tabs.nth(i).innerText()).trim();
	await tabs.nth(i).locator('a').click();
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(1500);
	if (await page.getByText('Failed to load this tab').count())
		errors.push(`${name} tab: "Failed to load this tab"`);
	else if (!(await page.locator('.treadle-tab-content > *').count()))
		errors.push(`${name} tab: rendered nothing`);
	await page.screenshot({ path: `${out}/${i}-${name.replace(/\W+/g, '_')}.png`, fullPage: true });
	console.log(`ok   ${name} tab rendered`);
}

console.log(`${n} tabs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const e of errors)
	console.log(`FAIL ${e}`);
console.log(errors.length ? `${errors.length} error(s)` : 'no JS errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
