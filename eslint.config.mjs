// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave
//
// Lint config for the LuCI views. LuCI loads each view as a plain script
// wrapped in a function, so a module ends in a top-level `return` and the
// names bound by its 'require …' lines arrive as function parameters. Both
// are declared here rather than per file.

const luciGlobals = {
	// LuCI runtime
	E: "readonly", _: "readonly", N_: "readonly", L: "readonly",
	// 'require <module>' bindings
	baseclass: "readonly", dom: "readonly", form: "readonly", rpc: "readonly",
	session: "readonly", uci: "readonly", ui: "readonly", view: "readonly",
	badges: "readonly", formpanel: "readonly", ordersave: "readonly",
	subs: "readonly", subsync: "readonly", uid: "readonly",
	statusPanel: "readonly", nodesPanel: "readonly", routingPanel: "readonly",
	settingsPanel: "readonly", basicPanel: "readonly"
};

const browserGlobals = {
	window: "readonly", document: "readonly", console: "readonly",
	setTimeout: "readonly", clearTimeout: "readonly", Promise: "readonly",
	Node: "readonly", Event: "readonly", navigator: "readonly",
	requestAnimationFrame: "readonly", getComputedStyle: "readonly",
	Blob: "readonly", URL: "readonly", confirm: "readonly"
};

export default [
	{
		files: ["htdocs/**/*.js"],
		languageOptions: {
			ecmaVersion: 2015,
			sourceType: "script",
			parserOptions: { ecmaFeatures: { globalReturn: true } },
			globals: { ...luciGlobals, ...browserGlobals }
		},
		rules: {
			"no-undef": "error",
			"no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
			"no-redeclare": "error",
			"no-dupe-keys": "error",
			"no-unreachable": "error",
			"no-constant-condition": ["error", { checkLoops: false }],
			"no-self-assign": "error",
			"no-unsafe-finally": "error",
			"use-isnan": "error",
			"valid-typeof": "error",
			"eqeqeq": ["error", "smart"],
			"no-restricted-properties": ["error",
				{ property: "innerHTML", message: "Build DOM with E() instead." }],
			"no-restricted-globals": ["error",
				{ name: "setInterval", message: "Reschedule a single setTimeout instead." },
				{ name: "fetch", message: "Use rpc.declare(); raw fetch bypasses CSRF protection." },
				{ name: "XMLHttpRequest", message: "Use rpc.declare(); raw XHR bypasses CSRF protection." }]
		}
	}
];
