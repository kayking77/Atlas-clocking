/* Atlas Timeclock — admin portal */
(function () {
  'use strict';

  const CFG = window.ATLAS_CONFIG || {};
  const configured = CFG.supabaseUrl && !/YOUR-PROJECT/.test(CFG.supabaseUrl);
  const sb = window.supabase.createClient(configured ? CFG.supabaseUrl : 'https://not-configured.supabase.co', CFG.supabaseAnonKey || 'missing');

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    profile: null,
    settings: null,
    tab: 'live',
    offset: 0,
    period: null,
    today: null,
    orgs: [],
    houses: [],
    staff: [],
    entries: [],
    subs: [],
    closure: null,
    open: [],
    orgFilter: 'all',
    loadedPeriod: null,
    liveUpdated: null,
  };
  let pollTimer = null;
  let tickTimer = null;

  // ------------------------------------------------------------------
  //  Formatting
  // ------------------------------------------------------------------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function fmtTime(local) {
    const m = String(local || '').match(/[T ](\d{2}):(\d{2})/);
    if (!m) return '—';
    const h = +m[1];
    return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function ymd(d) {
    const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
    return { y, m, d: dd, dow: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() };
  }
  const fmtDate = (d) => { const p = ymd(d); return `${DAYS[p.dow]}, ${MONTHS[p.m - 1]} ${p.d}`; };
  const fmtShort = (d) => { const p = ymd(d); return `${MONTHS[p.m - 1]} ${p.d}`; };
  const fmtLong = (d) => { const p = ymd(d); return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`; };
  const fmtHours = (h) => (h == null ? '—' : Number(h).toFixed(2));
  const sum = (arr, f) => arr.reduce((s, x) => s + Number(f(x) || 0), 0);
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }
  const nextDay = (a, b) => a && b && String(a).slice(0, 10) !== String(b).slice(0, 10);
  const coords = (lat, lng) => (lat == null ? '—' : `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`);

  function errMsg(e) {
    const raw = (e && (e.message || e.error_description)) || String(e);
    const m = raw.match(/^([A-Z_]{3,}):\s*([\s\S]*)$/);
    return m ? m[2] : raw;
  }

  // Wall-clock time in Atlas's timezone ("2026-09-22T15:00") → UTC ISO string.
  function tzOffsetMs(utcMs, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
  }
  function localToISO(local, tz) {
    const m = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const off = tzOffsetMs(guess, tz);
    let utc = guess - off;
    const off2 = tzOffsetMs(utc, tz);
    if (off2 !== off) utc = guess - off2;
    return new Date(utc).toISOString();
  }
  const tz = () => (S.settings && S.settings.timezone) || 'America/New_York';

  function toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  // ------------------------------------------------------------------
  //  Data
  // ------------------------------------------------------------------
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  async function loadRef() {
    const [st, o, h, p] = await Promise.all([
      sb.from('settings').select('*').eq('id', 1).single(),
      sb.from('organizations').select('*').order('name'),
      sb.from('houses').select('*').order('name'),
      sb.from('profiles').select('*').order('full_name'),
    ]);
    for (const r of [st, o, h, p]) if (r.error) throw r.error;
    S.settings = st.data;
    S.orgs = o.data;
    S.houses = h.data;
    S.staff = p.data;
  }

  async function loadPeriod() {
    const [pp, t] = await Promise.all([sb.rpc('pay_period', { p_offset: S.offset }), sb.rpc('local_today')]);
    if (pp.error) throw pp.error;
    if (t.error) throw t.error;
    S.period = pp.data[0];
    S.today = t.data;
    const start = S.period.period_start;
    const [entries, subs, cl] = await Promise.all([
      fetchAll(() => sb.from('clock_entries_detail').select('*').eq('period_start', start).order('clock_in')),
      sb.from('timesheet_submissions').select('*').eq('period_start', start),
      sb.from('period_closures').select('*').eq('period_start', start).maybeSingle(),
    ]);
    if (subs.error) throw subs.error;
    S.entries = entries;
    S.subs = subs.data;
    S.closure = cl.data || null;
    S.loadedPeriod = start;
  }

  async function loadOpen() {
    S.open = await fetchAll(() => sb.from('clock_entries_detail').select('*').is('clock_out', null).order('clock_in'));
    S.liveUpdated = new Date();
  }

  async function callStaffApi(action, payload) {
    if (window.ATLAS_DEMO) throw new Error('Staff logins can’t be created or changed in the demo.');
    const { data } = await sb.auth.getSession();
    const token = data.session && data.session.access_token;
    const res = await fetch(CFG.staffApi || 'api/staff.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(Object.assign({ action }, payload)),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || `The staff service answered ${res.status}.`);
    return j;
  }

  // ------------------------------------------------------------------
  //  Views
  // ------------------------------------------------------------------
  const orgName = (id) => (S.orgs.find((o) => o.id === id) || {}).name || '—';
  const houseById = (id) => S.houses.find((h) => h.id === id);

  function flagChips(e, withOpen = true) {
    const c = [];
    if (withOpen && !e.clock_out) c.push('<span class="chip on"><span class="dot"></span>On the clock</span>');
    if (e.in_inside === false) c.push(`<span class="chip warn">In: ${esc(e.in_distance_m)} m away</span>`);
    if (e.out_inside === false) c.push(`<span class="chip warn">Out: ${esc(e.out_distance_m)} m away</span>`);
    if (e.in_mocked || e.out_mocked) c.push('<span class="chip bad">Simulated GPS</span>');
    if (e.source === 'admin') c.push('<span class="chip accent">Admin entry</span>');
    else if (e.edited_at) c.push('<span class="chip accent">Edited</span>');
    return c.join(' ');
  }
  function noteText(e) {
    return [e.in_note && `In: ${e.in_note}`, e.out_note && `Out: ${e.out_note}`, e.admin_note && `Admin: ${e.admin_note}`].filter(Boolean).map(esc).join('<br>');
  }

  function viewLive() {
    const long = (e) => Date.now() - Date.parse(e.clock_in) > 16 * 3600e3;
    const cards = S.open
      .map(
        (e) => `
      <article class="live-card ${e.flagged || long(e) ? 'flag' : ''}">
        <div class="row"><span class="chip on"><span class="dot"></span>On the clock</span>${long(e) ? '<span class="chip warn">16h+ — missed clock-out?</span>' : ''}</div>
        <div class="timer" data-since="${esc(e.clock_in)}">${fmtElapsed(Date.now() - Date.parse(e.clock_in))}</div>
        <h2>${esc(e.staff_name)}</h2>
        <div><strong>${esc(e.house_name)}</strong> · ${esc(e.org_name)}<div class="meta">${esc(e.house_address)}</div></div>
        <div class="meta">In at ${fmtTime(e.clock_in_local)}, ${fmtDate(e.work_date)} · <span class="mono">${esc(e.in_distance_m)} m</span> from house</div>
        ${e.in_inside === false || e.in_mocked ? `<div class="row">${flagChips(e, false)}</div>` : ''}
        ${e.in_note ? `<div class="meta">Note: ${esc(e.in_note)}</div>` : ''}
        <div class="row"><button class="btn small" data-act="edit-entry" data-id="${e.id}">Edit shift</button></div>
      </article>`
      )
      .join('');
    return `
      <div class="page-head">
        <div><h1>On the clock</h1><p class="sub">${S.open.length} ${S.open.length === 1 ? 'person is' : 'people are'} working now${S.liveUpdated ? ` · updated ${S.liveUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</p></div>
        <div class="row"><button class="btn" data-act="refresh">Refresh</button></div>
      </div>
      ${S.open.length ? `<div class="live-grid">${cards}</div>` : '<div class="panel empty">Nobody is on the clock right now.</div>'}`;
  }

  function periodBar() {
    const p = S.period;
    const status = S.closure
      ? `<span class="chip accent">Closed ${fmtShort(String(S.closure.closed_at).slice(0, 10))}</span>`
      : S.today > p.period_end
      ? '<span class="chip warn">Ended — ready to close</span>'
      : '<span class="chip on">In progress</span>';
    return `
      <div class="row">
        <button class="icon-btn" data-act="prev-period" aria-label="Previous pay period">‹</button>
        <div><div class="eyebrow">Pay period</div><strong>${fmtLong(p.period_start)} – ${fmtLong(p.period_end)}</strong></div>
        <button class="icon-btn" data-act="next-period" aria-label="Next pay period" ${S.offset >= 0 ? 'disabled' : ''}>›</button>
        ${status}
      </div>`;
  }

  function viewTimesheets() {
    const p = S.period;
    const closed = S.entries.filter((e) => e.clock_out);
    const openCount = S.entries.length - closed.length;
    const flagged = S.entries.filter((e) => e.flagged).length;
    const worked = new Set(S.entries.map((e) => e.staff_id));
    const submitted = S.subs.filter((s) => worked.has(s.staff_id)).length;
    const total = sum(closed, (e) => e.hours);

    const orgs = S.orgs.filter((o) => (o.active || S.entries.some((e) => e.org_id === o.id)) && (S.orgFilter === 'all' || S.orgFilter === o.id));

    const orgPanels = orgs
      .map((o) => {
        const rows = S.entries.filter((e) => e.org_id === o.id);
        const orgHours = sum(rows.filter((e) => e.clock_out), (e) => e.hours);
        const houses = S.houses.filter((h) => h.org_id === o.id);
        const withRows = houses.filter((h) => rows.some((e) => e.house_id === h.id));
        const idle = houses.filter((h) => h.active && !rows.some((e) => e.house_id === h.id)).length;
        const body = withRows
          .map((h) => {
            const hr = rows.filter((e) => e.house_id === h.id);
            const sub = sum(hr.filter((e) => e.clock_out), (e) => e.hours);
            return `
              <tr class="group"><td colspan="6">${esc(h.name)}<span class="hint">${esc(h.address)}</span></td></tr>
              ${hr
                .map(
                  (e) => `
                <tr class="clickable ${e.flagged ? 'flag' : ''}" data-act="edit-entry" data-id="${e.id}" tabindex="0">
                  <td>${fmtDate(e.work_date)}</td>
                  <td>${esc(e.staff_name)}</td>
                  <td class="num">${fmtTime(e.clock_in_local)}</td>
                  <td class="num">${e.clock_out ? fmtTime(e.clock_out_local) + (nextDay(e.clock_in_local, e.clock_out_local) ? ' <span class="hint">+1</span>' : '') : '—'}</td>
                  <td class="num r">${e.clock_out ? fmtHours(e.hours) : 'open'}</td>
                  <td><div class="row" style="gap:4px">${flagChips(e)}</div><div class="notes">${noteText(e)}</div></td>
                </tr>`
                )
                .join('')}
              <tr class="subtotal"><td colspan="4">Subtotal — ${esc(h.name)}</td><td class="num r">${fmtHours(sub)}</td><td></td></tr>`;
          })
          .join('');
        return `
          <section class="panel">
            <div class="panel-head">
              <h2>${esc(o.name)}</h2>
              <span class="spacer"></span>
              <div class="org-total"><span class="eyebrow">Total</span><b>${fmtHours(orgHours)}</b><span class="hint">hrs</span></div>
              <button class="btn small" data-act="dl-org" data-id="${o.id}" ${rows.length ? '' : 'disabled'}>Download Excel</button>
            </div>
            ${
              withRows.length
                ? `<div class="table-wrap"><table>
                    <thead><tr><th>Date</th><th>Staff</th><th>Time in</th><th>Time out</th><th class="r">Hours</th><th>Flags &amp; notes</th></tr></thead>
                    <tbody>${body}</tbody></table></div>`
                : '<div class="empty">No shifts at this organization’s houses this period.</div>'
            }
            ${withRows.length && idle ? `<div class="panel-body hint">${idle} other ${idle === 1 ? 'house' : 'houses'} had no shifts.</div>` : ''}
          </section>`;
      })
      .join('');

    // staff submissions
    const staffRows = S.staff
      .filter((s) => worked.has(s.id) || (s.active && s.role === 'staff'))
      .map((s) => {
        const mine = S.entries.filter((e) => e.staff_id === s.id);
        const hrs = sum(mine.filter((e) => e.clock_out), (e) => e.hours);
        const sub = S.subs.find((x) => x.staff_id === s.id);
        const mismatch = sub && Math.abs(Number(sub.total_hours) - hrs) > 0.009;
        return `<tr>
          <td>${esc(s.full_name)}</td>
          <td class="num r">${mine.length}</td>
          <td class="num r">${fmtHours(hrs)}</td>
          <td>${
            sub
              ? `<span class="chip on">Submitted ${fmtShort(String(sub.submitted_at).slice(0, 10))}</span> ${mismatch ? `<span class="chip warn">Changed since: ${fmtHours(sub.total_hours)} h signed</span>` : ''}`
              : mine.length
              ? '<span class="chip">Not submitted</span>'
              : '<span class="hint">No shifts</span>'
          }</td></tr>`;
      })
      .join('');

    return `
      <div class="page-head">
        <div><h1>Timesheets</h1>${periodBar()}</div>
        <div class="row">
          <button class="btn" data-act="add-entry" ${S.closure ? 'disabled' : ''}>Add shift</button>
          <button class="btn" data-act="dl-all" ${closed.length ? '' : 'disabled'}>Download all organizations</button>
          ${S.closure ? '<button class="btn" data-act="reopen-period">Reopen period</button>' : `<button class="btn primary" data-act="close-period" ${S.today >= p.period_end ? '' : 'disabled title="Available on the last day of the period"'}>Close &amp; export period</button>`}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${fmtHours(total)}</b><span>Total hours</span></div>
        <div class="stat"><b>${closed.length}</b><span>Completed shifts</span></div>
        <div class="stat"><b>${worked.size}</b><span>Staff who worked</span></div>
        <div class="stat ${openCount ? 'on' : ''}"><b>${openCount}</b><span>Open shifts</span></div>
        <div class="stat ${flagged ? 'warn' : ''}"><b>${flagged}</b><span>Flagged for review</span></div>
        <div class="stat"><b>${submitted}/${worked.size}</b><span>Timesheets submitted</span></div>
      </div>
      <div class="row">
        <label class="f" style="min-width:260px">Organization
          <select id="org-filter">
            <option value="all">All organizations</option>
            ${S.orgs.map((o) => `<option value="${o.id}" ${S.orgFilter === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>
        </label>
      </div>
      ${orgPanels || '<div class="panel empty">No organizations yet. Add them under Organizations &amp; houses.</div>'}
      <section class="panel">
        <div class="panel-head"><h2>Staff sign-off</h2><span class="hint">Staff submit from the app on the last day of the period.</span></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Staff</th><th class="r">Shifts</th><th class="r">Hours</th><th>Timesheet</th></tr></thead>
          <tbody>${staffRows || '<tr><td colspan="4" class="empty">No staff yet.</td></tr>'}</tbody>
        </table></div>
      </section>`;
  }

  function viewHouses() {
    const panels = S.orgs
      .map((o) => {
        const hs = S.houses.filter((h) => h.org_id === o.id);
        return `
        <section class="panel">
          <div class="panel-head">
            <h2>${esc(o.name)}</h2>
            ${o.active ? '' : '<span class="chip">Archived</span>'}
            <span class="spacer"></span>
            <button class="btn small" data-act="add-house" data-org="${o.id}">Add house</button>
            <button class="btn small" data-act="edit-org" data-id="${o.id}">Edit</button>
          </div>
          ${
            hs.length
              ? `<div class="table-wrap"><table>
                <thead><tr><th>House</th><th>Address</th><th>Coordinates</th><th class="r">Geofence</th><th>Status</th><th></th></tr></thead>
                <tbody>${hs
                  .map(
                    (h) => `<tr>
                  <td><strong>${esc(h.name)}</strong></td>
                  <td>${esc(h.address)}</td>
                  <td class="mono"><a href="https://www.google.com/maps?q=${h.lat},${h.lng}" target="_blank" rel="noopener">${coords(h.lat, h.lng)}</a></td>
                  <td class="num r">${h.radius_m} m</td>
                  <td>${h.active ? '<span class="chip on">Active</span>' : '<span class="chip">Archived</span>'}</td>
                  <td class="r"><button class="btn small" data-act="edit-house" data-id="${h.id}">Edit</button></td>
                </tr>`
                  )
                  .join('')}</tbody></table></div>`
              : '<div class="empty">No houses yet.</div>'
          }
        </section>`;
      })
      .join('');
    return `
      <div class="page-head">
        <div><h1>Organizations &amp; houses</h1><p class="sub">Staff are matched to the nearest active house when they clock in. The geofence is how close they must be.</p></div>
        <div class="row"><button class="btn primary" data-act="add-org">Add organization</button></div>
      </div>
      ${panels || '<div class="panel empty">Add your first organization, then its houses.</div>'}`;
  }

  function viewStaff() {
    const p = S.period;
    const rows = S.staff
      .map((s) => {
        const hrs = sum(S.entries.filter((e) => e.staff_id === s.id && e.clock_out), (e) => e.hours);
        return `<tr>
          <td><strong>${esc(s.full_name)}</strong></td>
          <td>${esc(s.email || '')}</td>
          <td>${esc(s.phone || '')}</td>
          <td>${s.role === 'admin' ? '<span class="chip accent">Admin</span>' : 'Staff'}</td>
          <td class="num r">${fmtHours(hrs)}</td>
          <td>${s.active ? '<span class="chip on">Active</span>' : '<span class="chip">Inactive</span>'}</td>
          <td class="r"><div class="row" style="justify-content:flex-end">
            <button class="btn small" data-act="edit-staff" data-id="${s.id}">Edit</button>
            <button class="btn small" data-act="reset-pw" data-id="${s.id}">Reset password</button>
            ${s.id === S.profile.id ? '' : `<button class="btn small ${s.active ? 'danger' : ''}" data-act="toggle-staff" data-id="${s.id}">${s.active ? 'Deactivate' : 'Activate'}</button>`}
          </div></td></tr>`;
      })
      .join('');
    return `
      <div class="page-head">
        <div><h1>Staff</h1><p class="sub">Staff sign in to the Atlas Timeclock app with the email and password you set here.</p></div>
        <div class="row"><button class="btn primary" data-act="add-staff">Add staff</button></div>
      </div>
      <section class="panel"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th class="r">Hours ${p ? `${fmtShort(p.period_start)}–${fmtShort(p.period_end)}` : ''}</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">No staff yet.</td></tr>'}</tbody>
      </table></div></section>`;
  }

  function viewSettings() {
    const s = S.settings;
    return `
      <div class="page-head"><div><h1>Settings</h1><p class="sub">Changes apply to every staff app immediately.</p></div></div>
      <section class="panel"><form id="settings-form" class="panel-body" style="display:grid;gap:16px" novalidate>
        <div class="grid2">
          <label class="f">Company name<input name="company_name" value="${esc(s.company_name)}" required></label>
          <label class="f">Timezone<input name="timezone" value="${esc(s.timezone)}" required><span class="hint">IANA name, e.g. America/New_York</span></label>
          <label class="f">Pay period starts on<input name="period_anchor" type="date" value="${esc(s.period_anchor)}" required><span class="hint">The first day of any past or future pay period.</span></label>
          <label class="f">Pay period length (days)<input name="period_length_days" type="number" min="7" max="31" value="${esc(s.period_length_days)}" required><span class="hint">14 = bi-weekly</span></label>
          <label class="f">Default geofence (m)<input name="default_radius_m" type="number" min="25" max="2000" value="${esc(s.default_radius_m)}" required></label>
          <label class="f">Reject GPS worse than (m)<input name="max_accuracy_m" type="number" min="10" max="2000" value="${esc(s.max_accuracy_m)}" required></label>
        </div>
        <div class="row"><button class="btn primary" type="submit">Save settings</button><span id="settings-msg" class="hint"></span></div>
      </form></section>
      <section class="panel">
        <div class="panel-head"><h2>Two-factor sign-in</h2></div>
        <div class="panel-body" id="mfa-panel"><span class="hint">Loading…</span></div>
      </section>`;
  }

  const VIEWS = { live: viewLive, timesheets: viewTimesheets, houses: viewHouses, staff: viewStaff, settings: viewSettings };

  function render() {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === S.tab)));
    $('#main').innerHTML = VIEWS[S.tab]();
    if (S.tab === 'settings') renderMfaPanel();
  }

  async function loadTab() {
    clearInterval(pollTimer);
    $('#main').innerHTML = '<div class="empty">Loading…</div>';
    try {
      if (S.tab === 'live') {
        await loadOpen();
        pollTimer = setInterval(async () => {
          try { await loadOpen(); if (S.tab === 'live' && !$('#dlg').open) render(); } catch (_) { /* keep last view */ }
        }, 30000);
      } else if (S.tab === 'timesheets' || S.tab === 'staff') {
        await loadPeriod();
      }
      render();
    } catch (e) {
      $('#main').innerHTML = `<div class="panel empty">Couldn’t load this page: ${esc(errMsg(e))}</div>`;
    }
  }

  // live timers
  function tick() {
    document.querySelectorAll('[data-since]').forEach((el) => (el.textContent = fmtElapsed(Date.now() - Date.parse(el.dataset.since))));
  }

  // ------------------------------------------------------------------
  //  Dialogs
  // ------------------------------------------------------------------
  let dlgSubmit = null;
  function openDialog(html, onSubmit) {
    const form = $('#dlg-form');
    form.innerHTML = html;
    dlgSubmit = onSubmit;
    $('#dlg').showModal();
    const first = form.querySelector('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea');
    if (first) first.focus();
  }
  function closeDialog() {
    $('#dlg').close();
    dlgSubmit = null;
  }
  function dlgError(msg) {
    let el = $('#dlg-form .msg');
    if (!el) {
      el = document.createElement('div');
      el.className = 'msg bad';
      $('#dlg-form .actions').before(el);
    }
    el.textContent = msg;
  }
  function confirmDialog({ title, body, confirm, danger }, action) {
    openDialog(
      `<h2>${esc(title)}</h2><div>${body}</div>
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button>
       <button type="submit" class="btn ${danger ? 'danger solid' : 'primary'}">${esc(confirm)}</button></div>`,
      action
    );
  }

  function houseOptions(selected) {
    return S.orgs
      .map((o) => {
        const hs = S.houses.filter((h) => h.org_id === o.id && (h.active || h.id === selected));
        if (!hs.length) return '';
        return `<optgroup label="${esc(o.name)}">${hs.map((h) => `<option value="${h.id}" ${h.id === selected ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</optgroup>`;
      })
      .join('');
  }

  async function editEntry(id) {
    const e = id ? S.entries.concat(S.open).find((x) => x.id === id) : null;
    const isNew = !e;
    const staffOpts = S.staff
      .filter((s) => s.active || (e && s.id === e.staff_id))
      .map((s) => `<option value="${s.id}" ${e && e.staff_id === s.id ? 'selected' : ''}>${esc(s.full_name)}</option>`)
      .join('');
    const gps = e && e.source === 'app'
      ? `<div class="hint mono">GPS in: ${coords(e.in_lat, e.in_lng)} · ±${esc(e.in_accuracy_m)} m · ${esc(e.in_distance_m)} m from house${e.in_mocked ? ' · SIMULATED' : ''}${
          e.out_lat != null ? `<br>GPS out: ${coords(e.out_lat, e.out_lng)} · ±${esc(e.out_accuracy_m)} m · ${esc(e.out_distance_m)} m from house${e.out_mocked ? ' · SIMULATED' : ''}` : ''
        }</div>`
      : '';
    openDialog(
      `<h2>${isNew ? 'Add shift' : `Shift — ${esc(e.staff_name)}`}</h2>
       <label class="f">Staff<select name="staff_id" ${isNew ? '' : 'disabled'} required><option value="">Choose…</option>${staffOpts}</select></label>
       <label class="f">House<select name="house_id" required><option value="">Choose…</option>${houseOptions(e && e.house_id)}</select></label>
       <div class="grid2">
         <label class="f">Clock in<input type="datetime-local" name="clock_in" value="${e ? esc(String(e.clock_in_local).slice(0, 16)) : ''}" required></label>
         <label class="f">Clock out<input type="datetime-local" name="clock_out" value="${e && e.clock_out_local ? esc(String(e.clock_out_local).slice(0, 16)) : ''}"><span class="hint">Leave blank if still on the clock.</span></label>
       </div>
       <span class="hint">Times are ${esc(tz())}.</span>
       ${e && (e.in_note || e.out_note) ? `<div class="hint">${noteText({ in_note: e.in_note, out_note: e.out_note })}</div>` : ''}
       ${gps}
       <label class="f">Admin note<textarea name="admin_note" maxlength="500" placeholder="Reason for the change">${esc(e ? e.admin_note || '' : '')}</textarea></label>
       ${isNew ? '' : '<div class="history" id="entry-history">Loading history…</div>'}
       <div class="actions">
         ${isNew ? '' : '<button type="button" class="btn danger left" data-act="delete-entry">Delete shift</button>'}
         <button type="button" class="btn" data-act="dlg-cancel">Cancel</button>
         <button type="submit" class="btn primary">${isNew ? 'Add shift' : 'Save changes'}</button>
       </div>`,
      async (fd) => {
        const inIso = localToISO(fd.get('clock_in'), tz());
        const outIso = fd.get('clock_out') ? localToISO(fd.get('clock_out'), tz()) : null;
        if (!inIso) return dlgError('Enter the clock-in time.');
        if (!fd.get('house_id')) return dlgError('Choose a house.');
        if (outIso && Date.parse(outIso) <= Date.parse(inIso)) return dlgError('Clock out must be after clock in.');
        if (outIso && Date.parse(outIso) - Date.parse(inIso) > 24 * 3600e3) return dlgError('A shift can’t be longer than 24 hours. Split it into two shifts.');
        const row = { house_id: fd.get('house_id'), clock_in: inIso, clock_out: outIso, admin_note: fd.get('admin_note').trim() || null };
        let res;
        if (isNew) {
          if (!fd.get('staff_id')) return dlgError('Choose a staff member.');
          if (!outIso) return dlgError('Enter a clock-out time for a manual shift.');
          res = await sb.from('clock_entries').insert(Object.assign({ staff_id: fd.get('staff_id') }, row));
        } else {
          res = await sb.from('clock_entries').update(row).eq('id', e.id);
        }
        if (res.error) return dlgError(errMsg(res.error).replace(/.*one_open_per_staff.*/, 'That staff member already has an open shift.'));
        closeDialog();
        toast(isNew ? 'Shift added.' : 'Shift updated.');
        await refreshCurrent();
      }
    );
    if (!isNew) {
      $('#dlg-form').dataset.entryId = e.id;
      const { data } = await sb.from('clock_entry_audit').select('action,via,changed_by,changed_at').eq('entry_id', e.id).order('changed_at');
      const box = $('#entry-history');
      if (box) {
        box.innerHTML =
          '<strong>History</strong>' +
          (data || [])
            .map((a) => {
              const who = (S.staff.find((s) => s.id === a.changed_by) || {}).full_name || (a.via === 'app' ? e.staff_name : 'System');
              const what = a.via === 'app' ? (a.action === 'insert' ? 'Clocked in (app)' : 'Clocked out (app)') : a.action === 'insert' ? 'Added by admin' : 'Edited';
              return `<div>${esc(new Date(a.changed_at).toLocaleString())} — ${esc(what)} · ${esc(who)}</div>`;
            })
            .join('');
      }
    }
  }

  async function deleteEntry(btn) {
    const id = $('#dlg-form').dataset.entryId;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Click again to delete';
      btn.classList.add('solid');
      return;
    }
    const { error } = await sb.from('clock_entries').delete().eq('id', id);
    if (error) return dlgError(errMsg(error));
    closeDialog();
    toast('Shift deleted.');
    await refreshCurrent();
  }

  function orgDialog(id) {
    const o = id ? S.orgs.find((x) => x.id === id) : null;
    openDialog(
      `<h2>${o ? 'Edit organization' : 'Add organization'}</h2>
       <label class="f">Organization name<input name="name" value="${esc(o ? o.name : '')}" required maxlength="120"></label>
       ${o ? `<label class="check"><input type="checkbox" name="active" ${o.active ? 'checked' : ''}> Active <span class="hint">Archived organizations’ houses can’t be clocked into.</span></label>` : ''}
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Save</button></div>`,
      async (fd) => {
        const name = fd.get('name').trim();
        if (!name) return dlgError('Enter a name.');
        const res = o
          ? await sb.from('organizations').update({ name, active: fd.get('active') === 'on' }).eq('id', o.id)
          : await sb.from('organizations').insert({ name });
        if (res.error) return dlgError(/duplicate/.test(res.error.message) ? 'An organization with that name already exists.' : errMsg(res.error));
        closeDialog();
        await loadRef();
        render();
        toast('Organization saved.');
      }
    );
  }

  function parseCoords(s) {
    const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  function houseDialog(id, orgId) {
    const h = id ? houseById(id) : null;
    openDialog(
      `<h2>${h ? 'Edit house' : 'Add house'}</h2>
       <label class="f">Organization<select name="org_id" required>${S.orgs
         .filter((o) => o.active || (h && h.org_id === o.id))
         .map((o) => `<option value="${o.id}" ${(h ? h.org_id : orgId) === o.id ? 'selected' : ''}>${esc(o.name)}</option>`)
         .join('')}</select></label>
       <label class="f">House name<input name="name" value="${esc(h ? h.name : '')}" required maxlength="120"></label>
       <label class="f">Street address<input name="address" value="${esc(h ? h.address : '')}" required maxlength="200"><span class="hint">Printed on the timesheet.</span></label>
       <div class="grid2">
         <label class="f">Coordinates<input name="coords" class="mono" value="${h ? `${h.lat}, ${h.lng}` : ''}" placeholder="41.94450, -71.28560" required><span class="hint">In Google Maps, right-click the house and click the numbers to copy them, then paste here.</span></label>
         <label class="f">Geofence radius (m)<input name="radius_m" type="number" min="25" max="2000" value="${h ? h.radius_m : S.settings.default_radius_m}" required><span class="hint">150 m suits most homes.</span></label>
       </div>
       ${h ? `<label class="check"><input type="checkbox" name="active" ${h.active ? 'checked' : ''}> Active</label>` : ''}
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Save house</button></div>`,
      async (fd) => {
        const c = parseCoords(fd.get('coords'));
        if (!c) return dlgError('Coordinates should look like 41.94450, -71.28560.');
        const row = {
          org_id: fd.get('org_id'),
          name: fd.get('name').trim(),
          address: fd.get('address').trim(),
          lat: c.lat,
          lng: c.lng,
          radius_m: parseInt(fd.get('radius_m'), 10),
        };
        if (!row.name || !row.address) return dlgError('Enter the house name and address.');
        if (!(row.radius_m >= 25 && row.radius_m <= 2000)) return dlgError('Geofence must be between 25 and 2000 m.');
        if (h) row.active = fd.get('active') === 'on';
        const res = h ? await sb.from('houses').update(row).eq('id', h.id) : await sb.from('houses').insert(row);
        if (res.error) return dlgError(/duplicate/.test(res.error.message) ? 'That organization already has a house with this name.' : errMsg(res.error));
        closeDialog();
        await loadRef();
        render();
        toast('House saved.');
      }
    );
  }

  function tempPassword() {
    const words = 'Harbor,Maple,Cedar,Summit,River,Willow,Beacon,Anchor,Meadow,Granite'.split(',');
    const a = new Uint32Array(3);
    crypto.getRandomValues(a);
    return `${words[a[0] % words.length]}-${words[a[1] % words.length]}-${1000 + (a[2] % 9000)}`;
  }

  function staffDialog(id) {
    const s = id ? S.staff.find((x) => x.id === id) : null;
    openDialog(
      `<h2>${s ? `Edit ${esc(s.full_name)}` : 'Add staff'}</h2>
       <label class="f">Full name<input name="full_name" value="${esc(s ? s.full_name : '')}" required maxlength="120"></label>
       ${s ? `<label class="f">Email<input value="${esc(s.email || '')}" disabled><span class="hint">Email is their login and can’t be changed here.</span></label>` : '<label class="f">Email (their login)<input name="email" type="email" required></label>'}
       <label class="f">Mobile phone<input name="phone" type="tel" value="${esc(s ? s.phone || '' : '')}"></label>
       <label class="f">Role<select name="role"><option value="staff" ${!s || s.role === 'staff' ? 'selected' : ''}>Staff — uses the mobile app</option><option value="admin" ${s && s.role === 'admin' ? 'selected' : ''}>Admin — uses this portal</option></select></label>
       ${s ? '' : `<label class="f">Temporary password<input name="password" class="mono" value="${tempPassword()}" required minlength="10"><span class="hint">Share it privately. They can keep it or you can reset it later.</span></label>`}
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">${s ? 'Save' : 'Create login'}</button></div>`,
      async (fd) => {
        const full_name = fd.get('full_name').trim();
        if (!full_name) return dlgError('Enter their name.');
        try {
          if (s) {
            if (s.id === S.profile.id && fd.get('role') !== 'admin') return dlgError('You can’t remove your own admin role.');
            const { error } = await sb.from('profiles').update({ full_name, phone: fd.get('phone').trim() || null, role: fd.get('role') }).eq('id', s.id);
            if (error) throw error;
          } else {
            await callStaffApi('create', {
              full_name,
              email: fd.get('email').trim(),
              phone: fd.get('phone').trim(),
              role: fd.get('role'),
              password: fd.get('password'),
            });
          }
        } catch (e) {
          return dlgError(errMsg(e));
        }
        closeDialog();
        await loadRef();
        render();
        toast(s ? 'Saved.' : `Login created for ${full_name}.`);
      }
    );
  }

  function resetPwDialog(id) {
    const s = S.staff.find((x) => x.id === id);
    openDialog(
      `<h2>Reset password — ${esc(s.full_name)}</h2>
       <label class="f">New password<input name="password" class="mono" value="${tempPassword()}" required minlength="10"></label>
       <p class="hint">Share it with them privately. They’ll use it the next time they sign in.</p>
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Set password</button></div>`,
      async (fd) => {
        try {
          await callStaffApi('reset_password', { user_id: s.id, password: fd.get('password') });
        } catch (e) {
          return dlgError(errMsg(e));
        }
        closeDialog();
        toast('Password updated. Share it with them privately.', 5000);
      }
    );
  }

  function toggleStaff(id) {
    const s = S.staff.find((x) => x.id === id);
    confirmDialog(
      {
        title: s.active ? `Deactivate ${s.full_name}?` : `Activate ${s.full_name}?`,
        body: s.active ? '<p>They won’t be able to sign in or clock in. Their past shifts stay on record.</p>' : '<p>They’ll be able to sign in and clock in again.</p>',
        confirm: s.active ? 'Deactivate' : 'Activate',
        danger: s.active,
      },
      async () => {
        try {
          await callStaffApi('set_active', { user_id: s.id, active: !s.active });
        } catch (e) {
          return dlgError(errMsg(e));
        }
        closeDialog();
        await loadRef();
        render();
        toast(s.active ? 'Deactivated.' : 'Activated.');
      }
    );
  }

  function closePeriodDialog() {
    const p = S.period;
    const open = S.entries.filter((e) => !e.clock_out);
    const worked = [...new Set(S.entries.map((e) => e.staff_id))];
    const missing = worked.filter((id) => !S.subs.some((s) => s.staff_id === id)).map((id) => (S.staff.find((s) => s.id === id) || {}).full_name);
    const total = sum(S.entries.filter((e) => e.clock_out), (e) => e.hours);
    if (open.length) {
      openDialog(
        `<h2>Close pay period</h2><div class="msg warn">${open.length} ${open.length === 1 ? 'shift is' : 'shifts are'} still open: ${open.map((e) => esc(e.staff_name)).join(', ')}. Enter clock-out times before closing.</div>
         <div class="actions"><button type="button" class="btn primary" data-act="dlg-cancel">OK</button></div>`,
        () => closeDialog()
      );
      return;
    }
    openDialog(
      `<h2>Close ${fmtShort(p.period_start)} – ${fmtShort(p.period_end)}</h2>
       <p><strong class="mono">${fmtHours(total)}</strong> hours across ${S.entries.length} shifts.</p>
       ${missing.length ? `<div class="msg warn">Not yet submitted by: ${missing.map(esc).join(', ')}.</div>` : '<div class="msg on">Every staff member who worked has submitted.</div>'}
       <p class="hint">Closing locks every shift in this period. You can reopen it later if a correction is needed.</p>
       <label class="check"><input type="checkbox" name="download" checked> Download the all-organizations Excel workbook</label>
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Close period</button></div>`,
      async (fd) => {
        const { error } = await sb.from('period_closures').insert({ period_start: p.period_start, period_end: p.period_end, closed_by: S.profile.id, total_hours: Math.round(total * 100) / 100 });
        if (error) return dlgError(errMsg(error));
        const dl = fd.get('download') === 'on';
        closeDialog();
        await refreshCurrent();
        toast('Pay period closed.');
        if (dl) exportAll();
      }
    );
  }

  function reopenDialog() {
    confirmDialog(
      { title: 'Reopen this pay period?', body: '<p>Shifts in this period become editable again and staff can resubmit. Export again after you make corrections.</p>', confirm: 'Reopen period' },
      async () => {
        const { error } = await sb.from('period_closures').delete().eq('period_start', S.period.period_start);
        if (error) return dlgError(errMsg(error));
        closeDialog();
        await refreshCurrent();
        toast('Pay period reopened.');
      }
    );
  }

  // ------------------------------------------------------------------
  //  Excel
  // ------------------------------------------------------------------
  async function saveWorkbook(built) {
    const buf = await built.workbook.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = built.filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`Downloaded ${built.filename}`);
  }
  function excelReady() {
    if (!window.ExcelJS) { toast('The Excel library didn’t load. Check your connection and reload the page.'); return false; }
    return true;
  }
  function exportOrg(orgId) {
    if (!excelReady()) return;
    const org = S.orgs.find((o) => o.id === orgId);
    const built = window.AtlasExport.buildOrgWorkbook(window.ExcelJS, { companyName: S.settings.company_name, org, period: S.period, houses: S.houses, rows: S.entries });
    if (S.entries.some((e) => e.org_id === orgId && !e.clock_out)) toast('Open shifts are left out of the workbook until they’re clocked out.', 4500);
    saveWorkbook(built);
  }
  function exportAll() {
    if (!excelReady()) return;
    const built = window.AtlasExport.buildAllWorkbook(window.ExcelJS, { companyName: S.settings.company_name, orgs: S.orgs, period: S.period, houses: S.houses, rows: S.entries });
    saveWorkbook(built);
  }

  // ------------------------------------------------------------------
  //  Two-factor
  // ------------------------------------------------------------------
  async function renderMfaPanel() {
    const box = $('#mfa-panel');
    if (!box) return;
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) { box.innerHTML = `<span class="hint">${esc(errMsg(error))}</span>`; return; }
    const factors = (data.totp || []).filter((f) => f.status === 'verified');
    box.innerHTML = factors.length
      ? `<div class="row"><span class="chip on">On</span><span>Your account asks for an authenticator code at sign-in.</span><span class="spacer"></span><button class="btn small danger" data-act="mfa-remove" data-id="${factors[0].id}">Turn off</button></div>`
      : `<div class="row"><span class="chip warn">Off</span><span>Protect payroll data with a 6-digit code from an authenticator app.</span><span class="spacer"></span><button class="btn small primary" data-act="mfa-enroll">Set up</button></div>`;
  }

  async function mfaEnroll() {
    // clear half-finished enrolments first
    const { data: list } = await sb.auth.mfa.listFactors();
    for (const f of (list && list.all) || []) if (f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Atlas admin ${Date.now()}` });
    if (error) return toast(errMsg(error));
    openDialog(
      `<h2>Set up two-factor sign-in</h2>
       <p>Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code.</p>
       <img src="${esc(data.totp.qr_code)}" alt="QR code for your authenticator app" width="180" height="180" style="background:#fff;padding:8px;border-radius:8px">
       <span class="hint">Can’t scan? Enter this key: <span class="mono">${esc(data.totp.secret)}</span></span>
       <label class="f">Code<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
       <div class="actions"><button type="button" class="btn" data-act="dlg-cancel">Cancel</button><button type="submit" class="btn primary">Turn on</button></div>`,
      async (fd) => {
        const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: String(fd.get('code')).trim() });
        if (e2) return dlgError('That code didn’t match. Check the time on your phone and try the newest code.');
        closeDialog();
        renderMfaPanel();
        toast('Two-factor sign-in is on.');
      }
    );
  }

  // ------------------------------------------------------------------
  //  Auth & boot
  // ------------------------------------------------------------------
  function show(view) {
    ['login', 'mfa', 'app'].forEach((v) => ($(`#view-${v}`).hidden = v !== view));
  }
  function showLogin(msg, tone = 'bad') {
    show('login');
    const m = $('#login-msg');
    m.hidden = !msg;
    m.className = `msg ${tone}`;
    m.textContent = msg || '';
  }

  async function afterSignIn() {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      show('mfa');
      $('#mfa-code').value = '';
      $('#mfa-code').focus();
      return;
    }
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return showLogin();
    const { data: prof, error } = await sb.from('profiles').select('*').eq('id', u.user.id).maybeSingle();
    if (error) return showLogin(errMsg(error));
    if (!prof || prof.role !== 'admin' || !prof.active) {
      await sb.auth.signOut();
      return showLogin('This portal is for Atlas administrators. Staff clock in with the Atlas Timeclock app.');
    }
    S.profile = prof;
    $('#who-name').textContent = prof.full_name;
    show('app');
    try {
      await loadRef();
    } catch (e) {
      $('#main').innerHTML = `<div class="panel empty">Couldn’t load data: ${esc(errMsg(e))}</div>`;
      return;
    }
    const fromHash = location.hash.slice(1);
    if (VIEWS[fromHash]) S.tab = fromHash;
    await loadTab();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
  }

  async function refreshCurrent() {
    if (S.tab === 'live') await loadOpen();
    else await loadPeriod();
    render();
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!configured) return showLogin('Add your Supabase URL and anon key to js/config.js first.');
    const btn = $('#login-btn');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#login-email').value.trim(), password: $('#login-password').value });
    btn.disabled = false;
    if (error) return showLogin(/invalid login/i.test(error.message) ? 'That email and password don’t match.' : errMsg(error));
    $('#login-password').value = '';
    afterSignIn();
  });

  $('#mfa-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const code = $('#mfa-code').value.trim();
    const { data } = await sb.auth.mfa.listFactors();
    const f = data && (data.totp || []).find((x) => x.status === 'verified');
    const m = $('#mfa-msg');
    if (!f) { m.hidden = false; m.textContent = 'No authenticator is set up for this account.'; return; }
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
    if (error) { m.hidden = false; m.textContent = 'That code didn’t match. Try the newest code.'; return; }
    m.hidden = true;
    afterSignIn();
  });

  $('#dlg-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!dlgSubmit) return closeDialog();
    const btn = ev.submitter || $('#dlg-form button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await dlgSubmit(new FormData($('#dlg-form')));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'org-filter') {
      S.orgFilter = ev.target.value;
      render();
    }
  });

  document.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'settings-form') return;
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const row = {
      company_name: fd.get('company_name').trim(),
      timezone: fd.get('timezone').trim(),
      period_anchor: fd.get('period_anchor'),
      period_length_days: parseInt(fd.get('period_length_days'), 10),
      default_radius_m: parseInt(fd.get('default_radius_m'), 10),
      max_accuracy_m: parseInt(fd.get('max_accuracy_m'), 10),
      updated_at: new Date().toISOString(),
    };
    try { new Intl.DateTimeFormat('en-US', { timeZone: row.timezone }); } catch (_) { $('#settings-msg').textContent = 'That timezone name isn’t recognized.'; return; }
    const { error } = await sb.from('settings').update(row).eq('id', 1);
    $('#settings-msg').textContent = error ? errMsg(error) : 'Saved.';
    if (!error) { await loadRef(); S.loadedPeriod = null; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('tr.clickable')) ev.target.click();
  });

  document.addEventListener('click', async (ev) => {
    const tabBtn = ev.target.closest('[data-tab]');
    if (tabBtn) {
      S.tab = tabBtn.dataset.tab;
      history.replaceState(null, '', `#${S.tab}`);
      loadTab();
      return;
    }
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'sign-out':
        await sb.auth.signOut();
        clearInterval(pollTimer);
        showLogin('You’re signed out.', 'on');
        break;
      case 'refresh': await refreshCurrent(); break;
      case 'prev-period': S.offset -= 1; await loadTab(); break;
      case 'next-period': if (S.offset < 0) { S.offset += 1; await loadTab(); } break;
      case 'edit-entry': editEntry(id); break;
      case 'add-entry': editEntry(null); break;
      case 'delete-entry': deleteEntry(el); break;
      case 'dl-org': exportOrg(id); break;
      case 'dl-all': exportAll(); break;
      case 'close-period': closePeriodDialog(); break;
      case 'reopen-period': reopenDialog(); break;
      case 'add-org': orgDialog(null); break;
      case 'edit-org': orgDialog(id); break;
      case 'add-house': houseDialog(null, el.dataset.org); break;
      case 'edit-house': houseDialog(id); break;
      case 'add-staff': staffDialog(null); break;
      case 'edit-staff': staffDialog(id); break;
      case 'reset-pw': resetPwDialog(id); break;
      case 'toggle-staff': toggleStaff(id); break;
      case 'mfa-enroll': mfaEnroll(); break;
      case 'mfa-remove': {
        const { error } = await sb.auth.mfa.unenroll({ factorId: id });
        toast(error ? errMsg(error) : 'Two-factor sign-in is off.');
        renderMfaPanel();
        break;
      }
      case 'dlg-cancel': closeDialog(); break;
    }
  });

  (async function boot() {
    if (!configured) return showLogin('Add your Supabase URL and anon key to js/config.js, then reload.', 'warn');
    const { data } = await sb.auth.getSession();
    if (!data.session) return showLogin();
    afterSignIn();
  })();
})();
