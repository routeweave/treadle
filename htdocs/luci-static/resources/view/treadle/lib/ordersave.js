// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Shared save() wrapper for the GridSection panels (nodes, routing,
// subscriptions). A drag reorders the UCI sections themselves, but
// build-config sorts on the `order` field, which the drag never touches.

'use strict';
'require baseclass';
'require uci';

return baseclass.extend({
	// Wrap a form.Map's save() to renumber `order` from each section's
	// current position. Only writes when the value actually changed, so an
	// unchanged save stages no phantom UCI changes. The GridSection modal's
	// own Save calls m.save() directly (bypassing the panel's handleSave),
	// so wrapping save() is what covers every save path. `pre`, when given,
	// runs before the renumber for panel-specific fixups (e.g. ensuring a
	// NamedSection exists).
	install: function(m, sectionType, pre) {
		var origSave = m.save;
		m.save = function() {
			if (typeof pre === 'function')
				pre();
			uci.sections('treadle', sectionType).forEach(function(sec, i) {
				if (sec['order'] !== String(i))
					uci.set('treadle', sec['.name'], 'order', String(i));
			});
			return origSave.apply(m, arguments);
		};
	}
});
