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

// Maps form fields <-> opera-proxy CLI flags inside the single 'args' UCI option.
var FIELDS = [
	{ key: 'country', flag: '-country', type: 'select', def: 'EU',
	  options: [['EU', 'Europe'], ['AS', 'Asia'], ['AM', 'Americas']] },
	{ key: 'socks_mode', flag: '-socks-mode', type: 'flag',
	  label: 'SOCKS5 mode', hint: 'Enabled = SOCKS5 proxy. Disabled = HTTP proxy.' },
	{ key: 'bind_address', flag: '-bind-address', type: 'text', def: '127.0.0.1:18080', label: 'Listen address' },
	{ key: 'verbosity', flag: '-verbosity', type: 'text', def: '20', label: 'Verbosity' },
	{ key: 'timeout', flag: '-timeout', type: 'text', def: '10s', label: 'Request timeout' },
	{ key: 'refresh', flag: '-refresh', type: 'text', def: '4h', label: 'Endpoint refresh interval' },
	{ key: 'server_selection', flag: '-server-selection', type: 'select', def: 'fastest',
	  options: [['first', 'first'], ['random', 'random'], ['fastest', 'fastest']], label: 'Server selection' },
	{ key: 'proxy', flag: '-proxy', type: 'text', label: 'Upstream proxy', placeholder: 'socks5://127.0.0.1:1080' },
	{ key: 'api_proxy', flag: '-api-proxy', type: 'text', label: 'API proxy', placeholder: 'http://127.0.0.1:8080' },
	{ key: 'cafile', flag: '-cafile', type: 'text', label: 'CA bundle file' },
	{ key: 'fake_sni', flag: '-fake-SNI', type: 'text', label: 'Fake SNI' },
	{ key: 'override_proxy_address', flag: '-override-proxy-address', type: 'text', label: 'Override proxy address' }
];

function parseArgs(str) {
	var tokens = (str || '').trim().split(/\s+/).filter(Boolean);
	var out = {};
	FIELDS.forEach(function (f) {
		if (f.type === 'flag') {
			out[f.key] = tokens.indexOf(f.flag) !== -1;
		} else {
			var i = tokens.indexOf(f.flag);
			out[f.key] = (i !== -1 && tokens[i + 1] !== undefined) ? tokens[i + 1] : '';
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
	return E('div', { 'class': 'cbi-value', 'style': 'display:inline-block;min-width:180px;margin-right:1em' }, [
		E('label', { 'class': 'cbi-value-title' }, title),
		E('div', {}, value),
		sub ? E('div', { 'class': 'cbi-value-description' }, sub) : ''
	]);
}

function renderInstance(inst) {
	var values = parseArgs(inst.args);
	var root = E('div', { 'class': 'cbi-section', 'data-instance': inst.name });

	var statusRow = E('div', { 'class': 'status-row' });
	var actionsRow = E('div', { 'class': 'cbi-page-actions' });

	function refreshStatus(i) {
		dom.content(statusRow, [
			statusCard('Service state', i.running ? E('span', { style: 'color:#2ecc71' }, 'Running') : E('span', { style: 'color:#e74c3c' }, 'Stopped'),
				i.running ? ('PID: ' + i.pid) : ''),
			statusCard('Proxy mode', i.socks_mode ? 'SOCKS5' : 'HTTP', 'Listen: ' + (i.listen || '\u2013')),
			statusCard('Process memory', i.running ? ((i.rss_kb / 1024).toFixed(1) + ' MB') : '\u2013')
		]);
	}

	refreshStatus(inst);

	var btnStart = E('button', { 'class': 'cbi-button cbi-button-positive' }, 'Start');
	var btnStop = E('button', { 'class': 'cbi-button cbi-button-negative' }, 'Stop');
	var btnRestart = E('button', { 'class': 'cbi-button' }, 'Restart');
	var btnTest = E('button', { 'class': 'cbi-button cbi-button-action' }, 'Test proxy');
	var btnSave = E('button', { 'class': 'cbi-button cbi-button-save' }, 'Save & apply');
	var lastAction = E('span', { 'class': 'cbi-value-description' }, '');

	btnStart.addEventListener('click', function () { runAction(inst.name, 'start'); });
	btnStop.addEventListener('click', function () { runAction(inst.name, 'stop'); });
	btnRestart.addEventListener('click', function () { runAction(inst.name, 'restart'); });
	btnTest.addEventListener('click', function () { runTest(inst.name); });

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
			if (res && res.success) {
				lastAction.textContent = 'Test OK (HTTP ' + res.http_code + ', ' + parseFloat(res.time_total).toFixed(2) + 's)';
			} else {
				lastAction.textContent = 'Test failed' + (res && res.http_code ? ' (HTTP ' + res.http_code + ')' : '');
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
		E('div', { 'class': 'cbi-section-descr' }, 'Runtime state'),
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
		return callGetInstances();
	},

	render: function (instances) {
		var container = E('div', { 'class': 'opera-proxy-instances' });

		(instances || []).forEach(function (inst) {
			container.appendChild(renderInstance(inst));
		});

		poll.add(function () {
			return callGetInstances().then(function (fresh) {
				(fresh || []).forEach(function (inst) {
					var node = container.querySelector('[data-instance="' + inst.name + '"]');
					if (node && node._refresh) node._refresh(inst);
				});
			});
		}, 5);

		return E('div', {}, [
			E('h2', {}, 'Opera Proxy'),
			E('div', { 'class': 'cbi-section-descr' },
				'Manage several opera-proxy instances. Each card below is an independent process.'),
			container
		]);
	}
});
