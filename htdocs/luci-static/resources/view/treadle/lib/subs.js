// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Subscription display helpers shared by the Nodes / Routing / Status
// panels. Subscriptions are keyed by their UCI section name — which IS the
// subscription's uid (see uid.js) and matches what list_outbounds emits in
// `subscription`.
// Two subscriptions can carry nodes with identical tags; the label shown
// in dropdowns must make clear which subscription a tag comes from, and
// listing order must match the Subscriptions section everywhere.

'use strict';
'require baseclass';
'require uci';

return baseclass.extend({
	// uid → display name (falls back to the uid when `name` is unset).
	nameMap: function() {
		var map = {};
		uci.sections('treadle', 'subscription').forEach(function(sub) {
			var u = sub['.name'];
			map[u] = sub.name || u;
		});
		return map;
	},

	// uid → index in Subscriptions-section order.
	orderMap: function() {
		var map = {};
		uci.sections('treadle', 'subscription').forEach(function(sub, idx) {
			map[sub['.name']] = idx;
		});
		return map;
	},

	// Sort group: 0 = manual node (no subscription), 1+ = subscriptions in
	// section order, Infinity = orphan (saved tag whose source is gone).
	groupKey: function(sub_id, orderMap) {
		if (!sub_id) return 0;
		if (sub_id in orderMap) return 1 + orderMap[sub_id];
		return Infinity;
	},

	// "<subscription>/<tag>" for a subscription node, bare tag for a manual
	// node or an orphan.
	labelFor: function(tag, sub_id, nameMap) {
		if (sub_id && nameMap[sub_id])
			return nameMap[sub_id] + '/' + tag;
		return tag;
	},

	// Manual node sections from the (staged) UCI view, tag-bearing only,
	// sorted by drag order then section name — the same ordering
	// list_outbounds emits for manual nodes. Choice lists must source
	// manual nodes from here rather than from list_outbounds: the RPC
	// reads committed disk state only, so a staged tag rename (or a
	// freshly added node) would otherwise be invisible until Save & Apply,
	// and a rule whose reference was rewritten by the rename propagation
	// would point at a choice the dropdown doesn't offer yet.
	manualNodes: function() {
		var list = uci.sections('treadle', 'node').filter(function(n) {
			return n.tag && n.tag !== '';
		});
		list.sort(function(a, b) {
			var ao = parseInt(a.order, 10) || 0, bo = parseInt(b.order, 10) || 0;
			if (ao !== bo) return ao - bo;
			return a['.name'] < b['.name'] ? -1 : a['.name'] > b['.name'] ? 1 : 0;
		});
		return list;
	},

	// Comparator for { group, idx, label } entries: subscription-section
	// order first, original index within a source, label as tiebreak.
	entryCompare: function(a, b) {
		if (a.group !== b.group) return a.group - b.group;
		if (a.idx   !== b.idx)   return a.idx   - b.idx;
		return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
	},

	// Ordered { tag, label } choices for any "pick a node" control: manual
	// nodes/groups first (from the staged UCI view — see manualNodes for
	// why not list_outbounds), then subscription nodes grouped in
	// subscription-section order. Shared by the Routing tab's outbound
	// dropdowns and the Status tab's default-node switcher so the two
	// lists cannot diverge. `outbounds` is a list_outbounds result; the
	// builtin direct/block choices are the caller's to add.
	serverEntries: function(outbounds) {
		var self = this;
		var names = this.nameMap(), order = this.orderMap();
		var entries = [];
		this.manualNodes().forEach(function(n, i) {
			entries.push({ tag: n.tag, label: n.tag, group: 0, idx: i });
		});
		(outbounds || []).forEach(function(ob, i) {
			if (!ob || !ob.subscription) return;  // manual handled above
			entries.push({
				tag:   ob.tag,
				label: self.labelFor(ob.tag, ob.subscription, names),
				group: self.groupKey(ob.subscription, order),
				idx:   i
			});
		});
		entries.sort(this.entryCompare);
		return entries;
	}
});
