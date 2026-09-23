/* Demo mode: a stand-in for the Supabase client that serves the sample data in
 * demo-data.js. Loaded only by demo.html. Reads work; changes are not saved. */
(function () {
  'use strict';
  const M = window.MOCK;
  window.ATLAS_DEMO = true;
  window.ATLAS_CONFIG = { supabaseUrl: 'https://demo.local', supabaseAnonKey: 'demo', staffApi: null };

  // keep the sample open shift "live": started 3h 12m ago
  M.rows.filter((r) => !r.clock_out).forEach((r) => (r.clock_in = new Date(Date.now() - 3.2 * 3600e3).toISOString()));
  M.houses.forEach((h, i) => { h.lat = +(41.90 + i * 0.017).toFixed(5); h.lng = +(-71.30 + i * 0.021).toFixed(5); h.radius_m = 150; });

  const SAMPLE_START = '2026-09-13';
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const DEMO_ERR = { message: 'DEMO: Changes aren’t saved in the demo. Connect Supabase to use the real portal.' };

  function query(table) {
    const st = { filters: [], single: false, write: false };
    const b = {
      select: () => b, order: () => b, range: () => b,
      eq: (k, v) => (st.filters.push([k, v]), b),
      is: (k, v) => (st.filters.push([k, v]), b),
      maybeSingle: () => ((st.single = true), b),
      single: () => ((st.single = true), b),
      insert: () => ((st.write = true), b),
      update: () => ((st.write = true), b),
      delete: () => ((st.write = true), b),
      then(res, rej) {
        if (st.write) return Promise.resolve({ data: null, error: DEMO_ERR }).then(res, rej);
        let data = {
          settings: { id: 1, company_name: 'Atlas Staffing', timezone: 'America/New_York', period_anchor: SAMPLE_START, period_length_days: 14, default_radius_m: 150, max_accuracy_m: 150 },
          organizations: M.orgs,
          houses: M.houses,
          profiles: M.profiles,
          clock_entries_detail: M.rows,
          timesheet_submissions: M.subs,
          period_closures: [],
          clock_entry_audit: [],
        }[table] || [];
        if (Array.isArray(data)) for (const [k, v] of st.filters) data = data.filter((r) => (v === null ? r[k] == null : r[k] === v));
        if (st.single) data = Array.isArray(data) ? data[0] || null : data;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  }

  const client = {
    from: query,
    rpc(name, args) {
      if (name === 'pay_period') {
        const s = addDays(SAMPLE_START, 14 * ((args && args.p_offset) || 0));
        return Promise.resolve({ data: [{ period_start: s, period_end: addDays(s, 13) }], error: null });
      }
      if (name === 'local_today') return Promise.resolve({ data: '2026-09-22', error: null });
      return Promise.resolve({ data: null, error: DEMO_ERR });
    },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'demo' } } }),
      getUser: () => Promise.resolve({ data: { user: { id: 'a1' } } }),
      signInWithPassword: () => Promise.resolve({ error: null }),
      signOut: () => Promise.resolve({}),
      mfa: {
        getAuthenticatorAssuranceLevel: () => Promise.resolve({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }),
        listFactors: () => Promise.resolve({ data: { totp: [], all: [] } }),
        enroll: () => Promise.resolve({ error: DEMO_ERR }),
        unenroll: () => Promise.resolve({ error: DEMO_ERR }),
        challengeAndVerify: () => Promise.resolve({ error: DEMO_ERR }),
      },
    },
  };
  window.supabase = { createClient: () => client };
})();
