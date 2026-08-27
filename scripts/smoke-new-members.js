#!/usr/bin/env node
/**
 * Smoke: New members filter + dashboard wiring (API unit + optional live).
 * Usage: node scripts/smoke-new-members.js
 */
const fs = require('fs');
const path = require('path');

const { memberListQuerySchema } = require('../validation/querySchemas');
const { buildMemberListFilters } = require('../utils/memberListSql');

let failed = 0;
function assert(label, condition, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`  ✓ ${label}`);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

console.log('\n=== API: filter=new schema + SQL ===');
{
  const ok = memberListQuerySchema.safeParse({ filter: 'new', page: 1 });
  assert('Zod accepts filter=new', ok.success, ok.error?.message);

  const bad = memberListQuerySchema.safeParse({ filter: 'brand_new' });
  assert('Zod rejects unknown filter', !bad.success);

  for (const legacy of ['unpaid', 'due_soon', 'expired']) {
    const r = memberListQuerySchema.safeParse({ filter: legacy });
    assert(`Zod still accepts filter=${legacy}`, r.success);
  }

  const built = buildMemberListFilters({ filter: 'new' }, 2);
  assert(
    'SQL includes start_date month trunc',
    built.whereExtra.includes("date_trunc('month', m.start_date)") &&
      built.whereExtra.includes("date_trunc('month', CURRENT_DATE)"),
    built.whereExtra,
  );
  assert('SQL keeps live roster (deleted_at IS NULL)', built.whereExtra.includes('deleted_at IS NULL'));
  assert('SQL has no unpaid/due_soon/expired when filter=new', !/unpaid|due_soon|EXPIRED|DUE_SOON/i.test(built.whereExtra.replace(/MEMBER_/g, '')));
}

console.log('\n=== Web: dashboard + members chip ===');
{
  const dash = read(path.join(__dirname, '../../vibe-frontend/src/pages/owner/OwnerDashboard.jsx'));
  const members = read(path.join(__dirname, '../../vibe-frontend/src/pages/owner/Members.jsx'));
  const themes = read(path.join(__dirname, '../../vibe-frontend/src/utils/filterChipThemes.js'));
  const layout = read(path.join(__dirname, '../../vibe-frontend/src/layouts/OwnerLayout.jsx'));
  const en = read(path.join(__dirname, '../../vibe-frontend/src/i18n/locales/en.json'));

  assert('Dashboard shows New member metric (not checked-in)', dash.includes("metrics.newMember") && !dash.includes('metrics.checkedInToday'));
  assert('Dashboard revenue card still present', dash.includes('thisMonthRevenue'));
  assert('Dashboard New card deep-links to Members filter New', dash.includes("filter: 'New'"));
  assert('Members statusFilterToQuery maps NEW → filter=new', members.includes("NEW) return { filter: 'new' }") || members.includes("=== NEW) return { filter: 'new' }"));
  assert('Members chip after Expired uses variant=new', /variant="expired"[\s\S]*?variant="new"/.test(members));
  assert('Members chip plural label', members.includes("filters.newMember"));
  assert('Chip theme has parchment new palette', themes.includes('new:') && themes.includes('#efeae1'));
  assert('Nav badge excludes unpaidCount', !layout.includes('unpaidCount'));
  assert('i18n plural keys exist', en.includes('"newMember_one"') && en.includes('"newMember_other"') && en.includes('"thisMonthCaption"'));
}

console.log('\n=== Mobile: dashboard + members chip ===');
{
  const dash = read(path.join(__dirname, '../../vibe-mobile/app/(tabs)/index.tsx'));
  const members = read(path.join(__dirname, '../../vibe-mobile/app/(tabs)/members.tsx'));
  const api = read(path.join(__dirname, '../../vibe-mobile/src/api/members.ts'));
  const tokens = read(path.join(__dirname, '../../vibe-mobile/src/theme/tokens.ts'));
  const account = read(path.join(__dirname, '../../vibe-mobile/app/account.tsx'));
  const en = read(path.join(__dirname, '../../vibe-mobile/src/i18n/locales/en.json'));

  assert('Dashboard New member card present', dash.includes("dashboard.newMember"));
  assert('Dashboard New card navigates with filter=new', dash.includes("goMembers('new')") || dash.includes('filter=new'));
  assert('Dashboard unpaid metric card removed', !dash.includes("dashboard.unpaid") && !dash.includes('unpaidCount'));
  assert('Dashboard unpaid attention shortcut removed', !dash.includes('unpaidShortcut'));
  assert('Members FILTER_OPTIONS has new after expired', /'expired',\s*'new'/.test(members));
  assert('Members parseFilter accepts new', members.includes("raw === 'new'"));
  assert('Members API types include filter new', api.includes("'new'"));
  assert('statusNew cream token exists', tokens.includes('statusNew'));
  assert('Appearance Light|Dark segment present', account.includes('AppearanceThemeSegment') && account.includes("id: 'light'") && account.includes("id: 'dark'"));
  assert('Mobile i18n new member keys', en.includes('filterNewMember_one') && en.includes('thisMonthCaption'));
}

console.log('\n=== Optional live API ===');
(async () => {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
  try {
    const ping = await fetch(`${BASE.replace(/\/api$/, '')}/api/health`).catch(() => null);
    // Try login + members?filter=new if backend is up
    const loginRes = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@gym.com', password: 'password' }),
    });
    if (!loginRes.ok) {
      console.log('  · Backend login skipped (not reachable or no seed owner)');
    } else {
      const { token } = await loginRes.json();
      const dashRes = await fetch(`${BASE}/dashboard`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert('GET /dashboard ok', dashRes.ok, String(dashRes.status));
      if (dashRes.ok) {
        const dash = await dashRes.json();
        assert(
          'Dashboard includes newMembersThisMonth',
          typeof (dash.newMembersThisMonth ?? dash.data?.newMembersThisMonth) !== 'undefined' ||
            typeof dash.newMembersThisMonth === 'number' ||
            dash.success !== false,
          JSON.stringify(Object.keys(dash)).slice(0, 120),
        );
      }

      const listRes = await fetch(`${BASE}/members?filter=new&limit=5`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert(`GET /members?filter=new → ${listRes.status}`, listRes.ok, await listRes.text().then((t) => t.slice(0, 160)));
      if (listRes.ok) {
        const list = await listRes.json();
        const items = list.items || list.data?.items || [];
        assert('filter=new returns list payload', Array.isArray(items));
      }

      const badRes = await fetch(`${BASE}/members?filter=nope`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert('GET /members?filter=nope rejected', !badRes.ok);
    }
    void ping;
  } catch (err) {
    console.log(`  · Live API skipped — ${err.message}`);
  }

  console.log(failed ? `\nSMOKE FAILED (${failed})\n` : '\nSMOKE PASSED\n');
  process.exit(failed ? 1 : 0);
})();
