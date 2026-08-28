// Fetches each institution's real research-output mix from the OpenAlex API
// (institution.topic_share, aggregated to OpenAlex "field" level) and writes
// data/research-focus.json. Run weekly by .github/workflows/research-focus-scan.yml,
// same pattern as the other scripts/*.js scanners in this repo.
//
// Why this exists: the Research Focus donut on each institution page used to
// be hand-typed estimates with no source. This replaces those numbers with
// real, citable data straight from OpenAlex, and records the exact OpenAlex
// institution ID + API URL used so the numbers can be independently checked.

const fs = require('fs');
const path = require('path');

const MAILTO = 'venturino.dino@gmail.com';
const OUT_PATH = path.join(__dirname, '..', 'data', 'research-focus.json');
const MANUAL_OVERRIDES_PATH = path.join(__dirname, 'research-focus-overrides.json');

// Institutions to resolve: {id, name, city}. Pulled from SEED_INSTITUTIONS in
// index.html at scan time isn't practical (that file is HTML+JS, not data),
// so the id/name/city list is kept here in sync with SEED_INSTITUTIONS.
const INSTITUTIONS = [
  { id: 'ku', name: 'University of Copenhagen', city: 'Copenhagen' },
  { id: 'au', name: 'Aarhus University', city: 'Aarhus' },
  { id: 'dtu', name: 'Technical University of Denmark', city: 'Kongens Lyngby' },
  { id: 'sdu', name: 'University of Southern Denmark', city: 'Odense' },
  { id: 'aau', name: 'Aalborg University', city: 'Aalborg' },
  { id: 'cbs', name: 'Copenhagen Business School', city: 'Frederiksberg' },
  { id: 'ruc', name: 'Roskilde University', city: 'Roskilde' },
  { id: 'itu', name: 'IT University of Copenhagen', city: 'Copenhagen' },
  { id: 'rigshospitalet', name: 'Rigshospitalet (Copenhagen University Hospital)', city: 'Copenhagen' },
  { id: 'auh', name: 'Aarhus University Hospital', city: 'Aarhus' },
  { id: 'ouh', name: 'Odense University Hospital', city: 'Odense' },
  { id: 'herlevgentofte', name: 'Copenhagen University Hospital – Herlev and Gentofte', city: 'Herlev' },
  { id: 'aalborguh', name: 'Aalborg University Hospital', city: 'Aalborg' },
  { id: 'bispebjergfrederiksberg', name: 'Copenhagen University Hospital – Bispebjerg and Frederiksberg', city: 'Copenhagen' },
  { id: 'amagerhvidovre', name: 'Copenhagen University Hospital – Amager and Hvidovre', city: 'Hvidovre' },
  { id: 'zealanduh', name: 'Zealand University Hospital', city: 'Køge' },
  { id: 'stenocph', name: 'Steno Diabetes Center Copenhagen', city: 'Herlev' },
  { id: 'stenoaarhus', name: 'Steno Diabetes Center Aarhus', city: 'Aarhus' },
  { id: 'ssi', name: 'Statens Serum Institut', city: 'Copenhagen' },
  { id: 'nbi', name: 'Niels Bohr Institute', city: 'Copenhagen' },
  { id: 'royalacademy', name: 'Royal Danish Academy of Sciences and Letters', city: 'Copenhagen' },
  { id: 'dmi', name: 'Danish Meteorological Institute', city: 'Copenhagen' },
  { id: 'geus', name: 'Geological Survey of Denmark and Greenland', city: 'Copenhagen' },
  { id: 'alexandra', name: 'Alexandra Institute', city: 'Aarhus' },
  { id: 'dti', name: 'Danish Technological Institute', city: 'Taastrup' },
  { id: 'cpr', name: 'Novo Nordisk Foundation Center for Protein Research', city: 'Copenhagen' },
  { id: 'cbmr', name: 'Novo Nordisk Foundation Center for Basic Metabolic Research', city: 'Copenhagen' },
  { id: 'renew', name: 'Novo Nordisk Foundation Center for Stem Cell Medicine (reNEW)', city: 'Copenhagen' },
  { id: 'inano', name: 'Interdisciplinary Nanoscience Center', city: 'Aarhus' },
  { id: 'dtuspace', name: 'DTU Space – National Space Institute', city: 'Kongens Lyngby' },
  { id: 'diis', name: 'Danish Institute for International Studies', city: 'Copenhagen' },
  { id: 'vive', name: 'VIVE – The Danish Center for Social Science Research', city: 'Copenhagen' },
  { id: 'dias', name: 'Danish Institute for Advanced Study', city: 'Odense' },
  { id: 'biosustain', name: 'Novo Nordisk Foundation Center for Biosustainability', city: 'Kongens Lyngby' },
  { id: 'niph', name: 'National Institute of Public Health', city: 'Odense' },
  { id: 'aias', name: 'Aarhus Institute of Advanced Studies', city: 'Aarhus' },
  { id: 'pioneerai', name: 'Pioneer Centre for Artificial Intelligence', city: 'Copenhagen' },
  { id: 'rockwoolresearch', name: 'Rockwool Foundation Research Unit', city: 'Copenhagen' },
  { id: 'bii', name: 'BioInnovation Institute', city: 'Copenhagen' },
  { id: 'novonordiskfoundation', name: 'Novo Nordisk Foundation', city: 'Hellerup' },
  { id: 'lundbeckfoundation', name: 'Lundbeck Foundation', city: 'Copenhagen' },
  { id: 'carlsbergfoundation', name: 'Carlsberg Foundation', city: 'Copenhagen' },
  { id: 'villumfoundation', name: 'Villum Foundation', city: 'Søborg' },
  { id: 'danishcancersociety', name: 'Danish Cancer Society', city: 'Copenhagen' },
  { id: 'dnrf', name: 'Danish National Research Foundation', city: 'Copenhagen' },
];

function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(MANUAL_OVERRIDES_PATH, 'utf8')); }
  catch (e) { return {}; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retries on 429/5xx with backoff so a transient rate-limit blip never gets
// mistaken for "this institution doesn't exist" by the caller.
//
// Guarded with an AbortController — plain fetch() has no timeout, so a
// stalled connection would otherwise hang the whole weekly workflow run
// indefinitely instead of retrying or falling back (the same failure mode
// found and fixed for news-scan.js's Anthropic call, generalized here).
async function apiGet(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': `denmark-crm-research-focus-scan (mailto:${MAILTO})` }, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.json();
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const wait = Math.min(2000 * attempt, 15000);
    await sleep(wait);
    return apiGet(url, attempt + 1);
  }
  throw new Error(`${res.status} ${res.statusText} for ${url}`);
}

// Resolve an institution's OpenAlex ID: manual override > exact-name NL search.
async function resolveInstitution(inst, overrides) {
  if (overrides[inst.id] === null) {
    return { notFound: true, reason: overrides[inst.id + '_reason'] || 'Manually marked not present on OpenAlex' };
  }
  if (overrides[inst.id]) {
    const oaId = overrides[inst.id];
    try {
      const rec = await apiGet(`https://api.openalex.org/institutions/${oaId}?mailto=${MAILTO}`);
      return { rec };
    } catch (e) {
      return { notFound: true, reason: `Override id ${oaId} failed: ${e.message}` };
    }
  }

  const q = encodeURIComponent(inst.name);
  const search = await apiGet(`https://api.openalex.org/institutions?search=${q}&filter=country_code:DK&per_page=10&mailto=${MAILTO}`);
  const results = search.results || [];
  if (!results.length) return { notFound: true, reason: 'No OpenAlex institution matched this name in Denmark' };

  // Prefer an exact (case-insensitive) display_name match, then an alternative-name
  // match, then the highest works_count result as a last resort.
  const norm = s => (s || '').toLowerCase().trim();
  let best = results.find(r => norm(r.display_name) === norm(inst.name));
  if (!best) {
    best = results.find(r => (r.display_name_alternatives || []).some(a => norm(a) === norm(inst.name)));
  }
  if (!best) {
    best = results.slice().sort((a, b) => (b.works_count || 0) - (a.works_count || 0))[0];
  }
  return { rec: best, ambiguous: results.length > 1 && norm(best.display_name) !== norm(inst.name) };
}

// Aggregate an institution's topic_share (or topics as a fallback) into
// OpenAlex "field" level, which is a close analogue of the CRM's old
// hand-picked categories but sourced from real publication data.
function aggregateFields(rec) {
  const rows = (rec.topic_share && rec.topic_share.length ? rec.topic_share : rec.topics) || [];
  if (!rows.length) return [];
  const useShare = !!(rec.topic_share && rec.topic_share.length);
  const byField = new Map();
  for (const t of rows) {
    const field = t.field && t.field.display_name;
    if (!field) continue;
    const weight = useShare ? (t.value || 0) : (t.count || 0);
    byField.set(field, (byField.get(field) || 0) + weight);
  }
  const total = Array.from(byField.values()).reduce((s, v) => s + v, 0);
  if (!total) return [];
  return Array.from(byField.entries())
    .map(([name, weight]) => ({ name, pct: Math.round((weight / total) * 1000) / 10 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
}

function loadPrevious() {
  try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
  catch (e) { return null; }
}

async function main() {
  const overrides = loadOverrides();
  const previous = loadPrevious();
  const out = { generatedAt: new Date().toISOString(), source: 'OpenAlex API (institution.topic_share)', institutions: {} };

  for (const inst of INSTITUTIONS) {
    process.stdout.write(`Resolving ${inst.id} (${inst.name})... `);
    try {
      const { rec, notFound, reason, ambiguous } = await resolveInstitution(inst, overrides);
      if (notFound || !rec) {
        console.log(`NOT FOUND (${reason})`);
        out.institutions[inst.id] = { notFound: true, reason: reason || 'Not found on OpenAlex', searchUrl: `https://openalex.org/institutions?search=${encodeURIComponent(inst.name)}` };
        await sleep(700);
        continue;
      }
      const oaId = rec.id.replace('https://openalex.org/', '');
      const full = rec.topic_share ? rec : await apiGet(`https://api.openalex.org/institutions/${oaId}?mailto=${MAILTO}`);
      const fields = aggregateFields(full);
      out.institutions[inst.id] = {
        openalexId: oaId,
        openalexName: full.display_name,
        ror: full.ids && full.ids.ror ? full.ids.ror.replace('https://ror.org/', '') : null,
        worksCount: full.works_count || 0,
        fields,
        ambiguous: !!ambiguous,
        sourceUrl: `https://openalex.org/institutions/${oaId}`,
        apiUrl: `https://api.openalex.org/institutions/${oaId}`,
      };
      console.log(`${oaId} — ${fields.length} fields, ${full.works_count} works${ambiguous ? ' (AMBIGUOUS MATCH — verify)' : ''}`);
    } catch (e) {
      console.log(`ERROR (${e.message})`);
      // A genuine fetch failure (rate limit exhausted, network issue) is not the
      // same claim as "this institution has no OpenAlex record" — keep them distinct
      // so the frontend doesn't tell the user something false about missing data.
      // Prefer stale-but-real data from the previous run over a transient blip.
      const prevEntry = previous && previous.institutions && previous.institutions[inst.id];
      if (prevEntry && !prevEntry.fetchError) {
        out.institutions[inst.id] = prevEntry;
        console.log(`  (keeping previous data for ${inst.id})`);
      } else {
        out.institutions[inst.id] = { fetchError: true, reason: `Fetch error: ${e.message}` };
      }
    }
    await sleep(700); // polite pool is generous, but no need to hammer it
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
