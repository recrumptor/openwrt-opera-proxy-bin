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
	'.op-panel button:disabled{cursor:not-allowed;opacity:.45}';

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
var FIELDS = [
	{ key: 'country', flag: '-country', type: 'select', def: 'EU',
	  options: [['EU', 'Europe'], ['AS', 'Asia'], ['AM', 'Americas']] },
	{ key: 'socks_mode', flag: '-socks-mode', type: 'flag',
	  label: 'SOCKS5 mode', hint: 'Enabled = SOCKS5 proxy. Disabled = HTTP proxy.' },
	{ key: 'bind_address', flag: '-bind-address', type: 'text', label: 'Listen address' },
	{ key: 'verbosity', flag: '-verbosity', type: 'text', def: '20', label: 'Logging verbosity',
	  hint: '10 debug, 20 info, 30 warning, 40 error, 50 critical, 60 silent' },
	{ key: 'timeout', flag: '-timeout', type: 'text', def: '10s', label: 'Request timeout' },
	{ key: 'refresh', flag: '-refresh', type: 'text', def: '4h', label: 'Endpoint refresh interval' },
	{ key: 'server_selection', flag: '-server-selection', type: 'select', def: 'fastest',
	  options: [['first', 'first'], ['random', 'random'], ['fastest', 'fastest']], label: 'Server selection' },
	{ key: 'proxy', flag: '-proxy', type: 'text', label: 'Upstream proxy', placeholder: 'socks5://127.0.0.1:1080' },
	{ key: 'api_proxy', flag: '-api-proxy', type: 'text', label: 'API proxy', placeholder: 'http://127.0.0.1:8080' },
	{ key: 'api_proxy_list_url', flag: '-api-proxy-list-url', type: 'text', label: 'API proxy list URL',
	  placeholder: 'https://example.com/proxy-list.txt' },
	{ key: 'fake_sni', flag: '-fake-SNI', type: 'text', label: 'Fake SNI', placeholder: 'www.google.com' },
	{ key: 'override_proxy_address', flag: '-override-proxy-address', type: 'text', label: 'Override proxy address',
	  placeholder: 'host:port, e.g. 1.2.3.4:443' }
];

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

function renderField(f, values) {
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

	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, f.label || f.key),
		E('div', { 'class': 'cbi-value-field' }, [
			input,
			f.hint ? E('div', { 'class': 'cbi-value-description' }, f.hint) : ''
		])
	]);
}

function statusCard(title, value, sub) {
	return E('div', {}, [
		E('div', { 'class': 'op-status-title' }, title),
		E('div', { 'class': 'op-status-value' }, value),
		E('div', { 'class': 'op-status-sub' }, sub || '\u00A0')
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
				i.running ? ('PID: ' + i.pid) : '\u2013'),
			statusCard('Proxy mode', i.socks_mode ? 'SOCKS5' : 'HTTP', 'Listen: ' + (i.listen || '\u2013')),
			statusCard('Process memory', i.running ? ((i.rss_kb / 1024).toFixed(1) + ' MB') : '\u2013', '\u00A0')
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
	FIELDS.forEach(function (f) { form.appendChild(renderField(f, values)); });

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
				'Manage several opera-proxy instances. Click a tab to switch between them; click \u270E to rename.'),
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
				var editBtn = E('button', { 'class': 'op-tab-edit', type: 'button', title: 'Rename' }, '\u270E');
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
