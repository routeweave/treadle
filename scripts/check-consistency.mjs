// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave
//
// Cross-checks between files that must agree but are edited by hand, run by
// lint.sh. A mismatch here otherwise shows up only at runtime: a method the
// ACL omits makes LuCI answer "Access denied" while a root `ubus call` still
// works, a misspelt require leaves a tab blank, a handler method no ACL
// lists is unreachable from the UI.
//
//   node scripts/check-consistency.mjs
//
// Checks:
//   - every luci.treadle method a view declares is in the ACL;
//   - the ACL and the rpcd handler list the same methods, each once, and no
//     method is both read and write;
//   - the ACL grants UCI access to the treadle config only;
//   - every 'require view.treadle.…' and the menu's view path name a file;
//   - the menu's ACL dependency is the ACL file's group.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = 'htdocs/luci-static/resources/view/treadle';
const RESOURCES = 'htdocs/luci-static/resources';
const ACL = 'root/usr/share/rpcd/acl.d/luci-app-treadle.json';
const MENU = 'root/usr/share/luci/menu.d/luci-app-treadle.json';
const HANDLER = 'root/usr/libexec/rpcd/luci.treadle';
const GROUP = 'luci-app-treadle';
const OBJECT = 'luci.treadle';

const errors = [];
const read = f => readFileSync(join(root, f), 'utf8');

function jsFiles(dir) {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e =>
		e.isDirectory() ? jsFiles(join(dir, e.name))
			: e.name.endsWith('.js') ? [ join(dir, e.name) ] : []);
}

// ── the ACL ─────────────────────────────────────────────────────────────────
const acl = JSON.parse(read(ACL));
const group = acl[GROUP];
if (!group)
	errors.push(`${ACL}: no "${GROUP}" group`);
const aclRead = group?.read?.ubus?.[OBJECT] ?? [];
const aclWrite = group?.write?.ubus?.[OBJECT] ?? [];
const aclAll = new Set([ ...aclRead, ...aclWrite ]);
for (const [ side, list ] of [ [ 'read', aclRead ], [ 'write', aclWrite ] ])
	for (const m of list.filter((m, i) => list.indexOf(m) !== i))
		errors.push(`${ACL}: ${m} is listed twice on the ${side} side`);
for (const m of aclRead.filter(m => aclWrite.includes(m)))
	errors.push(`${ACL}: ${m} is both read and write`);
for (const side of [ 'read', 'write' ]) {
	const uci = group?.[side]?.uci ?? [];
	if (uci.length !== 1 || uci[0] !== 'treadle')
		errors.push(`${ACL}: ${side}.uci must be [ "treadle" ], is ${JSON.stringify(uci)}`);
}

// ── the rpcd handler ────────────────────────────────────────────────────────
// Methods are the one-tab-indented keys of the `local methods = {` table,
// plus those added after it as `methods.<name> = {`.
const lua = read(HANDLER);
const tableStart = lua.indexOf('\nlocal methods = {\n');
const tableEnd = lua.indexOf('\n}\n', tableStart);
if (tableStart < 0 || tableEnd < 0)
	errors.push(`${HANDLER}: cannot find the methods table`);
const handler = new Set([
	...[ ...lua.slice(tableStart, tableEnd).matchAll(/^\t([a-z_]+) = \{/gm) ].map(m => m[1]),
	...[ ...lua.matchAll(/^methods\.([a-z_]+) = \{/gm) ].map(m => m[1]),
]);
for (const m of aclAll)
	if (!handler.has(m))
		errors.push(`${ACL}: ${m} has no method in ${HANDLER}`);
for (const m of handler)
	if (!aclAll.has(m))
		errors.push(`${HANDLER}: ${m} is in no ACL list, so LuCI cannot call it`);

// ── the views ───────────────────────────────────────────────────────────────
let declared = 0;
for (const f of jsFiles(VIEWS)) {
	const src = read(f);
	for (const [ , body ] of src.matchAll(/rpc\.declare\(\{([\s\S]*?)\}\)/g)) {
		const object = body.match(/object:\s*'([^']+)'/)?.[1];
		const method = body.match(/method:\s*'([^']+)'/)?.[1];
		if (object !== OBJECT)
			continue;
		declared++;
		if (!aclAll.has(method))
			errors.push(`${f}: declares ${OBJECT}.${method}, which no ACL list grants`);
	}
	for (const [ , mod ] of src.matchAll(/^'require (view\.treadle\.[\w.]+)(?: as \w+)?';/gm)) {
		const file = join(RESOURCES, ...mod.split('.')) + '.js';
		if (!existsSync(join(root, file)))
			errors.push(`${f}: 'require ${mod}' names ${file}, which does not exist`);
	}
}

// ── the menu ────────────────────────────────────────────────────────────────
for (const [ node, entry ] of Object.entries(JSON.parse(read(MENU)))) {
	if (entry.action?.type === 'view') {
		const file = join(RESOURCES, 'view', entry.action.path + '.js');
		if (!existsSync(join(root, file)))
			errors.push(`${MENU}: ${node} opens ${file}, which does not exist`);
	}
	for (const g of entry.depends?.acl ?? [])
		if (!acl[g])
			errors.push(`${MENU}: ${node} depends on ACL group "${g}", which ${ACL} does not define`);
}

for (const e of errors)
	console.log(e);
console.log(errors.length ? `${errors.length} problem(s)`
	: `views, ACL and handler in step: ${declared} declared calls, ${aclAll.size} ACL methods, ${handler.size} handler methods`);
process.exit(errors.length ? 1 : 0);
