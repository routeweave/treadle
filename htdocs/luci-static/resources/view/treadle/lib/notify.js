// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Notification banners for every panel, so the severity classes and the
// sticky-or-fading choice live in one place.
//
//  error    stays until dismissed — it names what went wrong, and must not
//           vanish while the user is looking elsewhere on the page
//  notice   fades — confirmations and neutral notes
//  warning  fades — something the user may want to know but need not act on
//
// `'error'` is the class most LuCI apps use for failures; `'notice'` is
// styled by every bundled theme, where `'info'` is not (Material).

'use strict';
'require baseclass';
'require ui';

var FADE_MS = 5000;

// A bare string becomes a paragraph; a node or array passes through.
function body(msg) {
	return (typeof msg === 'string') ? E('p', {}, [ msg ]) : msg;
}

return baseclass.extend({
	error: function(msg) {
		return ui.addNotification(null, body(msg), 'error');
	},

	notice: function(msg) {
		return ui.addTimeLimitedNotification(null, body(msg), FADE_MS, 'notice');
	},

	warning: function(msg) {
		return ui.addTimeLimitedNotification(null, body(msg), FADE_MS, 'warning');
	}
});
