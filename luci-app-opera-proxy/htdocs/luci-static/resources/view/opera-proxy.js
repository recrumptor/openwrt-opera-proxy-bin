'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require dom';

var callGetInstances = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'get_instances',
	expect: { instances: [] }
});

var callSetInstance = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'set_instance',
	params: ['name', 'enabled', 'args']
});

var callAction = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'action',
	params: ['name', 'action']
});

var callTest = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'test_proxy',
	params: ['name']
});

var callRename = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'rename_instance',
	params: ['old_name', 'new_name']
});

var callVersion = rpc.declare({
	object: 'luci.opera-proxy',
	method: 'get_version',
	expect: { version: 'unknown' }
});

// Folder-tab strip in the top-right corner, so switching between instances
// doesn't require scrolling past the other two.
// Only cosmetic add-ons that LuCI's native tab widget doesn't provide by itself.
var TAB_CSS = '.op-tab-dot{width:8px;height:8px;border-radius:50%;background:#e74c3c;flex:none;' +
	'display:inline-block;margin-right:6px;vertical-align:middle}' +
	'.op-tab-dot.running{background:#2ecc71}' +
	'.op-tab-edit{border:none;cursor:pointer;color:inherit;opacity:.85;font-size:12px;padding:1px 5px;' +
	'line-height:1.6;border-radius:4px;background:rgba(128,128,128,.18);margin-left:6px;vertical-align:middle}' +
	'.op-tab-edit:hover{opacity:1;background:rgba(128,128,128,.35)}' +
	'.op-tab-name-input{width:100px;font-weight:600}' +
	'.op-status-row{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));gap:16px;margin-bottom:10px}' +
	'.op-status-title{font-weight:600;margin-bottom:4px}' +
	'.op-status-value{margin-bottom:2px;min-height:1.3em}' +
	'.op-status-sub{font-size:.85em;opacity:.7;min-height:1.3em}' +
	'.op-panel button:disabled{cursor:not-allowed;opacity:.45}' +
	// Advanced-section chrome: collapsible header + right-side move checkbox.
	'.op-adv-header{cursor:pointer;user-select:none;margin-top:14px}' +
	'.op-adv-header:hover{opacity:.75}' +
	'.op-adv-body{padding-left:2px}' +
	'.op-cbi-flex{display:flex;align-items:flex-start;gap:8px}' +
	'.op-cbi-flex>.cbi-input-text,.op-cbi-flex>.cbi-input-select{flex:1;min-width:0}' +
	'.op-adv-toggle{flex:none !important;margin-top:6px !important;cursor:pointer}';

// Per-instance default listen address so three freshly-enabled instances
// don't all collide on the opera-proxy binary's own built-in default (127.0.0.1:18080).
var DEFAULT_LISTEN_BY_NAME = {
	'default': '127.0.0.1:18081',
	'Americas': '127.0.0.1:18082',
	'Asia': '127.0.0.1:18083'
};

function defaultListenFor(name, idx) {
	return DEFAULT_LISTEN_BY_NAME[name] || ('127.0.0.1:' + (18081 + idx));
}

// Maps form fields <-> opera-proxy CLI flags inside the single 'args' UCI option.
// Fields marked adv:true are "advanced": they live in the collapsible
// "Advanced settings" section by default, but can be moved to the main form
// (and back) with the per-row checkbox on the right side of every field.
var FIELDS = [
	// ---- Main settings (fixed in the main form, no move checkbox) ----
	{ key: 'country', flag: '-country', type: 'select', def: 'EU', fixed: true,
	  options: [['EU', 'Europe'], ['AS', 'Asia'], ['AM', 'Americas']] },
	{ key: 'socks_mode', flag: '-socks-mode', type: 'flag', fixed: true,
	  label: 'SOCKS5 mode', hint: 'Enabled = SOCKS5 proxy. Disabled = HTTP proxy.' },
	{ key: 'bind_address', flag: '-bind-address', type: 'text', fixed: true, label: 'Listen address' },
	{ key: 'server_selection', flag: '-server-selection', type: 'select', def: 'fastest', fixed: true,
	  options: [['first', 'first'], ['random', 'random'], ['fastest', 'fastest']], label: 'Server selection' },

	// ---- Everything else: lives in the collapsible "Advanced settings"
	// section, ordered alphabetically by CLI flag exactly as in the upstream
	// README "List of arguments". Fixed main fields above are interleaved
	// into this order too (country, socks-mode, bind-address, server-selection),
	// which keeps FIELD_ORDER consistent for sorted re-insertion.
	{ key: 'api_address', flag: '-api-address', type: 'text', adv: true, label: 'API address',
	  placeholder: 'IP address', hint: 'Override IP address of api2.sec-tunnel.com' },
	{ key: 'api_client_type', flag: '-api-client-type', type: 'text', adv: true, label: 'API client type',
	  placeholder: 'se0316' },
	{ key: 'api_client_version', flag: '-api-client-version', type: 'text', adv: true, label: 'API client version',
	  placeholder: 'Stable 114.0.5282.21' },
	{ key: 'api_login', flag: '-api-login', type: 'text', adv: true, label: 'API login', placeholder: 'se0316' },
	{ key: 'api_password', flag: '-api-password', type: 'text', adv: true, label: 'API password' },
	{ key: 'api_proxy', flag: '-api-proxy', type: 'text', adv: true, label: 'API proxy',
	  placeholder: 'http://127.0.0.1:8080', hint: 'Additional proxy server used to access the SurfEasy API' },
	{ key: 'api_proxy_file', flag: '-api-proxy-file', type: 'text', adv: true, label: 'API proxy file',
	  placeholder: '/etc/opera-proxy/proxies.txt',
	  hint: 'Candidate proxies for SurfEasy API access, tried in order until init/discover succeeds' },
	{ key: 'api_proxy_list_url', flag: '-api-proxy-list-url', type: 'text', adv: true, label: 'API proxy list URL',
	  placeholder: 'https://example.com/proxy-list.txt',
	  hint: 'URL of a text file with candidate proxies; falls back to -api-proxy-file if download fails' },
	{ key: 'api_proxy_parallel', flag: '-api-proxy-parallel', type: 'text', adv: true, label: 'API proxy parallel',
	  placeholder: '15', hint: 'How many API proxy candidates are tested in parallel' },
	{ key: 'api_user_agent', flag: '-api-user-agent', type: 'text', adv: true, label: 'API user agent',
	  placeholder: 'Mozilla/5.0 ... OPR/114.0.0.0' },
	{ key: 'bootstrap_dns', flag: '-bootstrap-dns', type: 'text', adv: true, label: 'Bootstrap DNS',
	  placeholder: 'https://1.1.1.1/dns-query,tls://9.9.9.9:853',
	  hint: 'Comma-separated DNS/DoH/DoT resolvers for initial SurfEasy API discovery (dns://, https://, tls://, tcp://)' },
	{ key: 'cafile', flag: '-cafile', type: 'text', adv: true, label: 'CA certificate bundle',
	  placeholder: '/etc/ssl/certs/ca-certificates.crt', hint: 'Custom CA certificate bundle file' },
	{ key: 'discover_csv', flag: '-discover-csv', type: 'text', adv: true, label: 'Discover CSV file',
	  placeholder: '/etc/opera-proxy/proxies.csv',
	  hint: 'Read proxy endpoints from CSV instead of SurfEasy discover API' },
	{ key: 'fake_sni', flag: '-fake-SNI', type: 'text', adv: true, label: 'Fake SNI', placeholder: 'www.google.com',
	  hint: 'Domain name used as SNI in outbound TLS and tunneled TLS ClientHello where possible' },
	{ key: 'init_retries', flag: '-init-retries', type: 'text', adv: true, label: 'Init retries',
	  placeholder: '0', hint: 'Number of attempts for initialization steps, 0 = unlimited retry' },
	{ key: 'init_retry_interval', flag: '-init-retry-interval', type: 'text', adv: true, label: 'Init retry interval',
	  placeholder: '5s', hint: 'Delay between initialization retries' },
	{ key: 'override_proxy_address', flag: '-override-proxy-address', type: 'text', adv: true,
	  label: 'Override proxy address', placeholder: 'host:port, e.g. 1.2.3.4:443',
	  hint: 'Use a fixed proxy address instead of the server address returned by SurfEasy API' },
	{ key: 'proxy', flag: '-proxy', type: 'text', adv: true, label: 'Upstream proxy',
	  placeholder: 'socks5://127.0.0.1:1080',
	  hint: 'Base proxy for all dial-outs: <http|https|socks5|socks5h>://[login:password@]host[:port]' },
	{ key: 'proxy_bypass', flag: '-proxy-bypass', type: 'text', adv: true, label: 'Proxy bypass',
	  placeholder: '*.example.com,api2.sec-tunnel.com',
	  hint: 'Comma-separated host/URL patterns that bypass the Opera proxy and connect directly' },
	{ key: 'proxy_blacklist', flag: '-proxy-blacklist', type: 'text', adv: true, label: 'Proxy blacklist file',
	  placeholder: '/etc/opera-proxy/blacklist.txt',
	  hint: 'File with blacklisted proxy addresses, one host[:port] per line' },
	{ key: 'refresh', flag: '-refresh', type: 'text', adv: true, def: '4h', label: 'Endpoint refresh interval' },
	{ key: 'refresh_retry', flag: '-refresh-retry', type: 'text', adv: true, label: 'Refresh retry interval',
	  placeholder: '5s', hint: 'Login refresh retry interval' },
	{ key: 'server_selection_dl_limit', flag: '-server-selection-dl-limit', type: 'text', adv: true,
	  label: 'Server selection DL limit', placeholder: '0',
	  hint: 'Restrict downloaded bytes per connection for fastest server selection, 0 = unlimited' },
	{ key: 'server_selection_test_url', flag: '-server-selection-test-url', type: 'text', adv: true,
	  label: 'Server selection test URL',
	  placeholder: 'https://ajax.googleapis.com/ajax/libs/angularjs/1.8.2/angular.min.js',
	  hint: 'URL used for the download benchmark of the fastest server selection policy' },
	{ key: 'server_selection_timeout', flag: '-server-selection-timeout', type: 'text', adv: true,
	  label: 'Server selection timeout', placeholder: '30s',
	  hint: 'Timeout for the server selection function to produce a result' },
	{ key: 'timeout', flag: '-timeout', type: 'text', adv: true, def: '10s', label: 'Request timeout' },
	{ key: 'verbosity', flag: '-verbosity', type: 'text', adv: true, def: '20', label: 'Logging verbosity',
	  hint: '10 debug, 20 info, 30 warning, 40 error, 50 critical, 60 silent' }
];

// Alphabetical order index (matches the FIELDS order above) used to re-insert
// a row at its proper sorted slot when it is moved back into the advanced
// section, instead of dropping it at the end.
var FIELD_ORDER = {};
FIELDS.forEach(function (f, i) { FIELD_ORDER[f.key] = i; });

// Per-browser layout state: which fields the user moved between the main form
// and the advanced section. Keyed by field key only (applies to all instances),
// so the choice survives page reloads without touching UCI/RPC.
var ADV_STATE_KEY = 'opera-proxy-field-layout';

function loadAdvState() {
	try {
		return JSON.parse(localStorage.getItem(ADV_STATE_KEY)) || { adv: [], main: [] };
	} catch (e) {
		return { adv: [], main: [] };
	}
}

function saveAdvState(st) {
	try {
		localStorage.setItem(ADV_STATE_KEY, JSON.stringify(st));
	} catch (e) {}
}

function arrayToggle(arr, key, on) {
	var i = arr.indexOf(key);
	if (on && i === -1) arr.push(key);
	if (!on && i !== -1) arr.splice(i, 1);
}

// Where should this field live right now? Advanced by default if marked adv,
// unless the user explicitly moved it to the main form, and vice versa.
function isAdvancedPlaced(f) {
	var st = loadAdvState();
	if (f.adv)
		return st.main.indexOf(f.key) === -1;
	return st.adv.indexOf(f.key) !== -1;
}

function parseArgs(str) {
	var tokens = (str || '').trim().split(/\s+/).filter(Boolean);
	var out = {};
	FIELDS.forEach(function (f) {
		if (f.type === 'flag') {
			out[f.key] = tokens.indexOf(f.flag) !== -1;
		} else {
			var i = tokens.indexOf(f.flag);
			var val = (i !== -1 && tokens[i + 1] !== undefined) ? tokens[i + 1] : '';
			// For selects, an absent flag should still resolve to a real, saved
			// choice (e.g. 'fastest') rather than silently defaulting to whatever
			// option happens to be listed first in the dropdown.
			if (!val && f.type === 'select' && f.def) val = f.def;
			out[f.key] = val;
		}
	});
	return out;
}

function buildArgs(values) {
	var parts = [];
	FIELDS.forEach(function (f) {
		var v = values[f.key];
		if (f.type === 'flag') {
			if (v) parts.push(f.flag);
		} else if (v !== undefined && v !== null && v !== '') {
			parts.push(f.flag, v);
		}
	});
	return parts.join(' ');
}

function readForm(root) {
	var values = {};
	FIELDS.forEach(function (f) {
		var el = root.querySelector('[data-field="' + f.key + '"]');
		if (!el) return;
		values[f.key] = (f.type === 'flag') ? el.checked : el.value;
	});
	return values;
}

// Renders one cbi-value row. The small checkbox on the right edge moves the
// row between the main form and the advanced section; its checked state always
// mirrors the current placement (checked = lives in advanced).
function renderField(f, values, inAdv, onMove) {
	var val = values[f.key];
	var input;

	if (f.type === 'select') {
		input = E('select', { 'class': 'cbi-input-select', 'data-field': f.key });
		f.options.forEach(function (o) {
			input.appendChild(E('option', { value: o[0], selected: (val === o[0]) || undefined }, o[1]));
		});
	} else if (f.type === 'flag') {
		input = E('input', {
			type: 'checkbox', 'data-field': f.key,
			checked: val ? '' : null
		});
	} else {
		input = E('input', {
			type: 'text', 'class': 'cbi-input-text', 'data-field': f.key,
			value: val || '', placeholder: f.placeholder || f.def || ''
		});
	}

	// Fixed fields (country, SOCKS5 mode, listen address, server selection)
	// have no move checkbox: they always stay in the main form.
	if (f.fixed) {
		return E('div', { 'class': 'cbi-value', 'data-key': f.key }, [
			E('label', { 'class': 'cbi-value-title' }, f.label || f.key),
			E('div', { 'class': 'cbi-value-field' }, [
				input,
				f.hint ? E('div', { 'class': 'cbi-value-description' }, f.hint) : ''
			])
		]);
	}

	var moveChk = E('input', {
		type: 'checkbox', 'class': 'op-adv-toggle',
		title: inAdv ? 'Move to main settings' : 'Move to advanced settings',
		checked: inAdv ? '' : null
	});
	moveChk.addEventListener('change', function () {
		onMove(f, moveChk.checked, moveChk);
	});

	return E('div', { 'class': 'cbi-value', 'data-key': f.key }, [
		E('label', { 'class': 'cbi-value-title' }, f.label || f.key),
		E('div', { 'class': 'cbi-value-field' }, [
			E('div', { 'class': 'op-cbi-flex' }, [ input, moveChk ]),
			f.hint ? E('div', { 'class': 'cbi-value-description' }, f.hint) : ''
		])
	]);
}

function statusCard(title, value, sub) {
	return E('div', {}, [
		E('div', { 'class': 'op-status-title' }, title),
		E('div', { 'class': 'op-status-value' }, value),
		E('div', { 'class': 'op-status-sub' }, sub || ' ')
	]);
}

function renderInstance(inst, idx) {
	var values = parseArgs(inst.args);
	if (!values.bind_address) values.bind_address = defaultListenFor(inst.name, idx);
	var root = E('div', { 'class': 'cbi-section', 'data-instance': inst.name });

	var statusRow = E('div', { 'class': 'op-status-row' });
	var actionsRow = E('div', { 'class': 'cbi-page-actions' });

	var btnStart = E('button', { 'class': 'cbi-button cbi-button-positive' }, 'Start');
	var btnStop = E('button', { 'class': 'cbi-button cbi-button-negative' }, 'Stop');
	var btnTest = E('button', { 'class': 'cbi-button cbi-button-action' }, 'Test proxy');

	function refreshStatus(i) {
		dom.content(statusRow, [
			statusCard('Service state', i.running ? E('span', { style: 'color:#2ecc71' }, 'Running') : E('span', { style: 'color:#e74c3c' }, 'Stopped'),
				i.running ? ('PID: ' + i.pid) : '–'),
			statusCard('Proxy mode', i.socks_mode ? 'SOCKS5' : 'HTTP', 'Listen: ' + (i.listen || '–')),
			statusCard('Process memory', i.running ? ((i.rss_kb / 1024).toFixed(1) + ' MB') : '–', ' ')
		]);
		btnStart.disabled = !!i.running;
		btnStop.disabled = !i.running;
		btnTest.disabled = !i.running;
	}

	refreshStatus(inst);

	var btnRestart = E('button', { 'class': 'cbi-button' }, 'Restart');
	var btnSave = E('button', { 'class': 'cbi-button cbi-button-save' }, 'Save & apply');
	var lastAction = E('span', { 'class': 'cbi-value-description' }, '');

	btnStart.addEventListener('click', function () { if (!btnStart.disabled) runAction(inst.name, 'start'); });
	btnStop.addEventListener('click', function () { if (!btnStop.disabled) runAction(inst.name, 'stop'); });
	btnRestart.addEventListener('click', function () { runAction(inst.name, 'restart'); });
	btnTest.addEventListener('click', function () { if (!btnTest.disabled) runTest(inst.name); });

	function runAction(name, action) {
		lastAction.textContent = 'Running ' + action + '...';
		callAction(name, action).then(function (res) {
			lastAction.textContent = 'Last action completed: ' + action + (res && res.success === false ? ' (failed)' : '');
			poll.trigger();
		});
	}

	function runTest(name) {
		lastAction.textContent = 'Testing proxy...';
		callTest(name).then(function (res) {
			var via = res && res.proxy_url ? (' via ' + res.proxy_url) : '';
			if (res && res.success) {
				lastAction.textContent = 'Test OK (HTTP ' + res.http_code + ', ' + parseFloat(res.time_total).toFixed(2) + 's)' + via;
			} else {
				lastAction.textContent = 'Test failed' + (res && res.http_code ? ' (HTTP ' + res.http_code + ')' : '') + via;
			}
		});
	}

	var enabledInput = E('input', { type: 'checkbox', 'data-field': '__enabled', checked: inst.enabled ? '' : null });

	// Main form and collapsible advanced section. Rows are moved between
	// mainForm and advBody purely by DOM reparenting; readForm()/buildArgs()
	// keep working because they address fields by data-field, not by position.
	var mainForm = E('div', {});
	var advBody = E('div', { 'class': 'op-adv-body', style: 'display:none' });
	var advArrow = E('span', {}, '▸ ');
	var advHeader = E('h4', { 'class': 'op-adv-header' }, [ advArrow, 'Advanced settings' ]);

	function setAdvOpen(open) {
		advBody.style.display = open ? '' : 'none';
		advArrow.textContent = open ? '▾ ' : '▸ ';
	}
	advHeader.addEventListener('click', function () {
		setAdvOpen(advBody.style.display === 'none');
	});

	var advSection = E('div', {}, [ advHeader, advBody ]);

	function onMove(f, toAdv, moveChk) {
		var st = loadAdvState();
		// Record the user's explicit choice against the field's default slot,
		// so defaults can be restored by unchecking everything.
		if (f.adv) {
			arrayToggle(st.main, f.key, !toAdv);
		} else {
			arrayToggle(st.adv, f.key, toAdv);
		}
		saveAdvState(st);
		if (toAdv) {
			// Insert at the field's alphabetical slot so round-tripping a row
			// between sections always lands it back in the same position.
			var row = fieldRows[f.key];
			var before = null;
			var kids = advBody.children;
			for (var i = 0; i < kids.length; i++) {
				var k = kids[i].getAttribute('data-key');
				if (k !== null && FIELD_ORDER[k] > FIELD_ORDER[f.key]) {
					before = kids[i];
					break;
				}
			}
			advBody.insertBefore(row, before);
		} else {
			mainForm.appendChild(fieldRows[f.key]);
		}
		moveChk.title = toAdv ? 'Move to main settings' : 'Move to advanced settings';
		// Open the advanced section so the moved row is actually visible.
		if (toAdv) setAdvOpen(true);
	}

	var fieldRows = {};
	FIELDS.forEach(function (f) {
		var inAdv = !f.fixed && isAdvancedPlaced(f);
		var row = renderField(f, values, inAdv, onMove);
		fieldRows[f.key] = row;
		if (inAdv) {
			// FIELDS is already in README alphabetical order, so plain
			// appends produce a sorted advanced section.
			advBody.appendChild(row);
		} else {
			mainForm.appendChild(row);
		}
	});

	btnSave.addEventListener('click', function () {
		var values = readForm(form);
		var args = buildArgs(values);
		var enabled = enabledInput.checked ? '1' : '0';
		btnSave.disabled = true;
		callSetInstance(inst.name, enabled, args).then(function () {
			btnSave.disabled = false;
			ui.addNotification(null, E('p', 'Saved and applied: ' + inst.name), 'info');
			poll.trigger();
		});
	});

	var form = E('div', {}, [
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, 'Enable service'),
			E('div', { 'class': 'cbi-value-field' }, [ enabledInput ])
		])
	]);
	form.appendChild(mainForm);
	form.appendChild(advSection);

	dom.content(root, [
		E('h3', {}, inst.name),
		statusRow,
		E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, 'Actions'),
			E('div', { 'class': 'cbi-value-field' }, [ btnStart, ' ', btnStop, ' ', btnRestart, ' ', btnTest ])
		]),
		lastAction,
		E('h4', {}, 'Configuration'),
		form,
		E('div', { 'class': 'cbi-page-actions' }, [ btnSave ])
	]);

	root._refresh = function (i) {
		refreshStatus(i);
	};

	return root;
}

return view.extend({
	load: function () {
		return Promise.all([ callGetInstances(), callVersion() ]);
	},

	render: function (data) {
		var instances = data[0] || [];
		var binaryVersion = data[1] || 'unknown';

		var panesWrap = E('div', {});
		var panesByName = {};

		instances.forEach(function (inst, idx) {
			var pane = renderInstance(inst, idx);
			pane.setAttribute('data-tab', inst.name);
			pane.setAttribute('data-tab-title', inst.name);
			if (idx === 0) pane.setAttribute('data-tab-active', 'true');
			panesByName[inst.name] = pane;
			panesWrap.appendChild(pane);
		});

		var root = E('div', {}, [
			E('style', {}, TAB_CSS),
			E('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' }, [
				E('h2', { style: 'margin:0' }, 'Opera Proxy'),
				E('span', { style: 'font-size:.8em;color:var(--color-text-secondary,#888)' }, 'version: ' + binaryVersion)
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				E('a', {
					href: 'https://github.com/recrumptor/openwrt-opera-proxy-bin',
					target: '_blank',
					rel: 'noreferrer',
					style: 'text-decoration:underline;color:var(--color-link,#2a6ebb)'
				}, 'github.com/recrumptor/openwrt-opera-proxy-bin')
			]),
			E('div', { 'class': 'cbi-section-descr' },
				'Manage several opera-proxy instances. Click a tab to switch between them; click ✎ to rename. ' +
				'Use the checkbox on the right of any setting to move it to (or from) the collapsible Advanced settings section.'),
			panesWrap
		]);

		// panesWrap must already be attached to its parent before initTabGroup runs,
		// since it inserts the generated <ul class="cbi-tabmenu"> as panesWrap's
		// previous sibling — i.e. right where a native LuCI tab bar normally sits.
		ui.tabs.initTabGroup(panesWrap.childNodes);

		var menu = root.querySelector('ul.cbi-tabmenu');

		function decorateTab(inst) {
			if (!menu) return;
			var li = menu.querySelector('li[data-tab="' + inst.name + '"]');
			if (!li) return;
			var a = li.querySelector('a');
			if (!a) return;

			var dot = a.querySelector('.op-tab-dot');
			if (!dot) {
				dot = E('span', { 'class': 'op-tab-dot' });
				a.insertBefore(dot, a.firstChild);
			}
			dot.classList.toggle('running', !!inst.running);

			if (!a.querySelector('.op-tab-edit')) {
				var editBtn = E('button', { 'class': 'op-tab-edit', type: 'button', title: 'Rename' }, '✎');
				editBtn.addEventListener('click', function (ev) {
					ev.preventDefault();
					ev.stopPropagation();
					var label = document.createTextNode(inst.name);
					var textNode = Array.prototype.find.call(a.childNodes, function (n) { return n.nodeType === 3; });
					var input = E('input', { type: 'text', 'class': 'op-tab-name-input', value: inst.name });

					a.replaceChild(input, textNode);
					input.focus();
					input.select();

					var settled = false;
					function commit() {
						if (settled) return;
						settled = true;
						var newName = input.value.trim();
						if (!newName || newName === inst.name) {
							a.replaceChild(label, input);
							return;
						}
						if (!/^[A-Za-z0-9_]+$/.test(newName)) {
							ui.addNotification(null, E('p', 'Name may contain only letters, digits and underscore'), 'error');
							a.replaceChild(label, input);
							return;
						}
						callRename(inst.name, newName).then(function (res) {
							if (res && res.success) {
								ui.addNotification(null, E('p', 'Renamed "' + inst.name + '" to "' + newName + '", reloading...'), 'info');
								setTimeout(function () { location.reload(); }, 700);
							} else {
								ui.addNotification(null, E('p', (res && res.error) || 'Rename failed'), 'error');
								a.replaceChild(label, input);
							}
						});
					}

					input.addEventListener('keydown', function (ev) {
						if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
						if (ev.key === 'Escape') { settled = true; a.replaceChild(label, input); }
					});
					input.addEventListener('blur', commit);
				});
				a.appendChild(editBtn);
			}
		}

		instances.forEach(decorateTab);

		poll.add(function () {
			return callGetInstances().then(function (fresh) {
				(fresh || []).forEach(function (inst) {
					var pane = panesByName[inst.name];
					if (pane && pane._refresh) pane._refresh(inst);
					decorateTab(inst);
				});
			});
		}, 5);

		return root;
	}
});
