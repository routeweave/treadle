// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Latency badge rendering shared by the Nodes panel (Latency column, the
// subscription-nodes modal) and the Status panel (Groups column), so the
// thresholds and colours cannot drift between the two.

'use strict';
'require baseclass';

// Bootstrap's `.label.important` is mapped to the primary (blue) colour
// and the theme has no built-in red label class, so the red band sets the
// background inline from the theme's error/danger CSS var (with a literal
// fallback for themes that define neither).
var DANGER_STYLE =
	' background-color: var(--danger-color, var(--error-color, var(--error-color-high, #d9534f)));' +
	' color: var(--on-danger-color, var(--on-error-color, #fff));';

// "2m ago" / "1h ago" / "3d ago" style relative timestamp from a unix epoch.
function relTime(ts) {
	if (!ts) return '';
	var diff = Math.floor(Date.now() / 1000 - ts);
	if (diff < 5)       return _('just now');
	if (diff < 60)      return diff + _('s ago');
	if (diff < 3600)    return Math.floor(diff / 60)    + _('m ago');
	if (diff < 86400)   return Math.floor(diff / 3600)  + _('h ago');
	return Math.floor(diff / 86400) + _('d ago');
}

return baseclass.extend({
	relTime: relTime,

	// Color-coded latency badge. Maps a probe result `{ delay_ms?, error?,
	// tested_at? }` to a span styled with the same label-* classes the rest
	// of Treadle uses.
	//  green   < 300 ms   (workable proxy path)
	//  yellow  < 600 ms   (degraded)
	//  red     ≥ 600 ms   or any error
	// `detailed` appends the tested-time as dimmed inline text. The default
	// keeps it in the title tooltip only, which suits dense grid columns
	// but is mouse-only — pass true where there's room (the
	// subscription-nodes modal) so touch and keyboard users see it too.
	formatLatency: function(result, detailed) {
		if (!result)
			return E('span', { 'style': 'opacity:0.45;' }, [ '—' ]);
		var badge;
		if (typeof result.delay_ms === 'number') {
			var ms = result.delay_ms;
			var attrs = {
				'style': 'padding:1px 6px; border-radius:3px; text-transform:none; cursor:help;',
				'title': result.tested_at ? _('Tested %s').format(relTime(result.tested_at)) : ''
			};
			if (ms < 300) {
				attrs['class'] = 'label success';
			} else if (ms < 600) {
				attrs['class'] = 'label warning';
			} else {
				attrs['class'] = 'label';
				attrs['style'] += DANGER_STYLE;
			}
			badge = E('span', attrs, [ ms + ' ms' ]);
		} else {
			// Probe failed: the cached `error` string is sing-box's own
			// message (mapped via probe_node), e.g. "timeout", "proxy not
			// in running config". Show it on hover so the cell doesn't
			// grow to the longest error length.
			var msg = result.error || _('error');
			badge = E('span', {
				'class': 'label',
				'style': 'padding:1px 6px; border-radius:3px; text-transform:none; cursor:help;' +
				         DANGER_STYLE,
				'title': msg + (result.tested_at ? '\n' + _('Tested %s').format(relTime(result.tested_at)) : '')
			}, [ msg.length > 14 ? msg.substring(0, 13) + '…' : msg ]);
		}
		if (!detailed || !result.tested_at)
			return badge;
		return E('span', { 'style': 'white-space:nowrap;' }, [
			badge, ' ',
			E('span', { 'style': 'opacity:0.55; font-size:0.85em;' }, [
				_('tested %s').format(relTime(result.tested_at))
			])
		]);
	}
});
