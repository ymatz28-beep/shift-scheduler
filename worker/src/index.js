/**
 * Shift Scheduler API — Cloudflare Worker + KV
 *
 * Endpoints:
 *   GET  /data          → read all shift data from KV
 *   PUT  /data          → write all shift data to KV
 *   GET  /health        → health check
 *   POST /notify        → manual trigger for WebEx notification
 *
 * Cron Triggers:
 *   Weekday 08:30 JST → morning schedule notification
 *   Weekday 17:00 JST → next-day preview notification
 *
 * KV key: "shift_data" (single JSON blob)
 */

const SCHEDULER_URL = 'https://ymatz28-beep.github.io/shift-scheduler/';

const CORS_HEADERS = {
	'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Pin',
	'Access-Control-Max-Age': '86400',
};

function corsHeaders(request, env) {
	const origin = request.headers.get('Origin') || '';
	const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
	if (allowed.includes(origin) || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
		return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': origin };
	}
	return { ...CORS_HEADERS, 'Access-Control-Allow-Origin': allowed[0] || '*' };
}

function jsonResp(data, status, cors = {}) {
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

// ============ Schedule Generation (same round-robin as frontend) ============

function shuffleArray(arr) {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

function getStatus(data, member, dateStr) {
	return (data.availability?.[member]?.[dateStr]) || 'available';
}

function generateSchedule(data, dateStr) {
	const members = data.team_members || [];
	const timeSlots = data.time_slots || [];
	const lateSlots = data.late_shift_slots || [];

	const lateShiftMembers = [];
	const regularMembers = [];

	for (const m of members) {
		const status = getStatus(data, m, dateStr);
		if (status === 'pto' || status === 'exclude') continue;
		if (status === 'late-shift') {
			lateShiftMembers.push(m);
		} else {
			regularMembers.push(m);
		}
	}

	const allAvailable = [...regularMembers, ...lateShiftMembers];
	if (allAvailable.length < 1) return null;

	const schedule = {};

	// Late-shift slots: only late-shift members
	const lateSlotList = timeSlots.filter(s => lateSlots.includes(s));
	if (lateSlotList.length > 0 && lateShiftMembers.length > 0) {
		const shuffledLate = shuffleArray(lateShiftMembers);
		for (let i = 0; i < lateSlotList.length; i++) {
			schedule[lateSlotList[i]] = [shuffledLate[i % shuffledLate.length]];
		}
	}

	// Round-robin for remaining slots
	const pool = regularMembers.length > 0 ? regularMembers : allAvailable;
	const shuffledPool = shuffleArray(pool);
	const slotsToFill = timeSlots.filter(s => !schedule[s]);
	for (let i = 0; i < slotsToFill.length; i++) {
		schedule[slotsToFill[i]] = [shuffledPool[i % shuffledPool.length]];
	}

	return schedule;
}

// ============ Date Helpers ============

function isWeekday(d) {
	return d.getDay() >= 1 && d.getDay() <= 5;
}

function nextWorkday(d) {
	const nxt = new Date(d);
	nxt.setDate(nxt.getDate() + 1);
	while (!isWeekday(nxt)) nxt.setDate(nxt.getDate() + 1);
	return nxt;
}

function formatDateISO(d) {
	return d.toISOString().split('T')[0];
}

// ============ WebEx Notification ============

function formatMessage(data, target, schedule, isEvening) {
	const dateStr = formatDateISO(target);
	const members = data.team_members || [];
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const dayLabel = days[target.getDay()];
	const y = target.getFullYear();
	const mo = String(target.getMonth() + 1).padStart(2, '0');
	const dd = String(target.getDate()).padStart(2, '0');
	const dateDisplay = `${y}/${mo}/${dd} (${dayLabel})`;

	const lines = [];
	if (isEvening) lines.push('📅 Tomorrow\'s Preview\n');
	lines.push(`📞 Phone Shift Schedule — ${dateDisplay}`);
	lines.push('━━━━━━━━━━━━━━━━━━━━━━━');

	for (const slot of (data.time_slots || [])) {
		const people = schedule[slot] || [];
		lines.push(`  ${slot}  →  ${people.join(' · ')}`);
	}

	lines.push('━━━━━━━━━━━━━━━━━━━━━━━');

	const late = members.filter(m => getStatus(data, m, dateStr) === 'late-shift');
	const pto = members.filter(m => getStatus(data, m, dateStr) === 'pto');
	if (late.length) lines.push(`🕐 Late shift: ${late.join(', ')}`);
	if (pto.length) lines.push(`🌴 PTO: ${pto.join(', ')}`);

	lines.push('\nHave a great day! 🙌');
	lines.push(`📋 ${SCHEDULER_URL}`);

	return lines.join('\n');
}

async function sendWebex(message, env) {
	const token = env.WEBEX_TOKEN;
	const roomId = env.WEBEX_ROOM_ID;

	if (!token || !roomId) {
		console.log('WEBEX_TOKEN or WEBEX_ROOM_ID not set, skipping');
		return { ok: false, reason: 'missing credentials' };
	}

	const resp = await fetch('https://webexapis.com/v1/messages', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ roomId, markdown: message }),
	});

	return { ok: resp.ok, status: resp.status };
}

async function handleNotify(env, mode) {
	const raw = await env.SHIFT_DATA.get('shift_data');
	const data = raw ? JSON.parse(raw) : DEFAULT_DATA;

	// JST = UTC+9
	const now = new Date();
	const jstOffset = 9 * 60 * 60 * 1000;
	const jstNow = new Date(now.getTime() + jstOffset);
	const today = new Date(jstNow.getFullYear(), jstNow.getMonth(), jstNow.getDate());

	const isEvening = mode === 'evening';
	const target = isEvening ? nextWorkday(today) : today;

	if (!isWeekday(target)) {
		return { skipped: true, reason: `${formatDateISO(target)} is not a weekday` };
	}

	const dateStr = formatDateISO(target);
	const schedule = generateSchedule(data, dateStr);
	if (!schedule) {
		return { skipped: true, reason: 'Not enough members' };
	}

	const message = formatMessage(data, target, schedule, isEvening);
	const result = await sendWebex(message, env);
	return { sent: true, mode, date: dateStr, webex: result, message };
}

// ============ Exports ============

export default {
	async fetch(request, env) {
		const cors = corsHeaders(request, env);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: cors });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/health') {
			return jsonResp({ status: 'ok', ts: new Date().toISOString() }, 200, cors);
		}

		if (path === '/data') {
			if (request.method === 'GET') {
				const raw = await env.SHIFT_DATA.get('shift_data');
				const data = raw ? JSON.parse(raw) : DEFAULT_DATA;
				return jsonResp(data, 200, cors);
			}

			if (request.method === 'PUT') {
				const body = await request.json();
				await env.SHIFT_DATA.put('shift_data', JSON.stringify(body));
				return jsonResp({ status: 'saved', ts: new Date().toISOString() }, 200, cors);
			}
		}

		if (path === '/notify' && request.method === 'POST') {
			const { mode } = await request.json().catch(() => ({ mode: 'morning' }));
			const result = await handleNotify(env, mode || 'morning');
			return jsonResp(result, 200, cors);
		}

		return jsonResp({ error: 'Not found' }, 404, cors);
	},

	// Cron Triggers
	async scheduled(event, env, ctx) {
		// Determine morning or evening based on JST hour
		const now = new Date();
		const jstHour = (now.getUTCHours() + 9) % 24;

		// Morning: ~08:30 JST (cron fires at 23:30 UTC)
		// Evening: ~17:00 JST (cron fires at 08:00 UTC)
		const mode = jstHour < 12 ? 'morning' : 'evening';

		const result = await handleNotify(env, mode);
		console.log('Cron result:', JSON.stringify(result));
	},
};
