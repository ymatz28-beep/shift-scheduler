/**
 * Shift Scheduler API — Cloudflare Worker + KV
 *
 * Endpoints:
 *   GET  /data          → read all shift data from KV
 *   PUT  /data          → write all shift data to KV
 *   GET  /health        → health check
 *
 * KV key: "shift_data" (single JSON blob, ~few KB for 6 members)
 */

const CORS_HEADERS = {
	'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Pin',
	'Access-Control-Max-Age': '86400',
};

function corsHeaders(request, env) {
	const origin = request.headers.get('Origin') || '';
	const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
	// Also allow localhost for dev
	if (allowed.includes(origin) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
		return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': origin };
	}
	return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': allowed[0] || '*' };
}

function json(data, status, cors) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...cors },
	});
}

const DEFAULT_DATA = {
	team_members: ['Seiryu', 'Masato', 'Yukio', 'Masayuki', 'Kosuke', 'Yancy'],
	time_slots: [
		'09:00–10:00', '10:00–11:00', '11:00–12:00',
		'12:00–13:00', '13:00–14:00', '14:00–15:00', '16:00–17:00',
	],
	late_shift_slots: [],
	people_per_slot: 1,
	availability: {},
	schedule: {},
	shift_counts: {},
};

export default {
	async fetch(request, env) {
		const cors = corsHeaders(request, env);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/health') {
			return json({ status: 'ok', ts: new Date().toISOString() }, 200, cors);
		}

		if (path === '/data') {
			if (request.method === 'GET') {
				const raw = await env.SHIFT_DATA.get('shift_data');
				const data = raw ? JSON.parse(raw) : DEFAULT_DATA;
				return json(data, 200, cors);
			}

			if (request.method === 'PUT') {
				const body = await request.json();
				await env.SHIFT_DATA.put('shift_data', JSON.stringify(body));
				return json({ status: 'saved', ts: new Date().toISOString() }, 200, cors);
			}
		}

		return json({ error: 'Not found' }, 404, cors);
	},
};
