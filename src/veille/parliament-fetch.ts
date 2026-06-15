/**
 * Autonomous parliamentary open-data ingestion for moltbot.
 * Fetches directly from public French open-data endpoints inside the GitHub
 * Action — NO dependency on the Voxa Intelligence server or pappers-maison.
 *
 * Each source is independent and non-fatal: a failure in one never blocks the
 * others, and never blocks the email veille.
 */

import { unzipSync } from 'fflate';

export interface ParliamentItem {
  source: 'senat' | 'an' | 'jorf';
  // QE / QG / QOSD / QC / nomination / amendement / dossier / scrutin / ppl
  sous_type: string;
  titre: string;
  auteur?: string;
  groupe?: string;
  ministere?: string;
  rubrique?: string;
  date?: string; // ISO date of deposit / latest activity
  date_reponse?: string; // ISO date of ministerial answer
  a_reponse: boolean;
  url: string;
  texte?: string;
}

/** Minimal RFC-4180-ish CSV parser supporting a custom delimiter and quoted fields. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Normalize a header label for fuzzy matching (strip accents, lowercase, spaces). */
function normHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Find the index of the first header whose normalized form includes ALL tokens. */
function findCol(headers: string[], ...tokenSets: string[][]): number {
  const normed = headers.map(normHeader);
  for (const tokens of tokenSets) {
    for (let i = 0; i < normed.length; i++) {
      if (tokens.every((t) => normed[i].includes(t))) return i;
    }
  }
  return -1;
}

/** Parse a French/ISO date string to ISO yyyy-mm-dd, or undefined. */
function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // Already ISO
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // dd/mm/yyyy
  const fr = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  return undefined;
}

/**
 * Fetch Sénat written/oral questions (rolling 12 months) and return only those
 * deposited OR answered on/after sinceIso (dual-date logic, per pappers-maison v3.2).
 */
export async function fetchSenatQuestions(sinceIso: string): Promise<ParliamentItem[]> {
  const url = 'https://data.senat.fr/data/questions/questions-depuis-un-an.csv';
  const resp = await fetch(url, { headers: { 'User-Agent': 'moltbot-veille' } });
  if (!resp.ok) throw new Error(`Sénat CSV HTTP ${resp.status}`);

  // CSV is ISO-8859-1 (latin-1), semicolon-separated
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder('latin1').decode(buf);
  const rows = parseCsv(text, ';');
  if (rows.length < 2) return [];

  const headers = rows[0];
  const cNature = findCol(headers, ['nature']); // QE / QG / QOSD / QC
  const cTitre = findCol(headers, ['titre'], ['intitule'], ['objet']);
  const cNom = findCol(headers, ['nom']); // "Nom"
  const cPrenom = findCol(headers, ['prenom']); // "Prénom"
  const cGroupe = findCol(headers, ['groupe']);
  const cMinDepot = findCol(headers, ['ministere', 'depot'], ['ministere', 'interroge']);
  const cMinRep = findCol(headers, ['ministere', 'reponse']);
  const cRub = findCol(headers, ['themes'], ['theme'], ['rubrique']);
  const cDate = findCol(headers, ['date', 'publication'], ['datedepot'], ['date']);
  const cDateRep = findCol(headers, ['date', 'reponse']);
  const cUrl = findCol(headers, ['url']);

  const items: ParliamentItem[] = [];
  let maxDate = '';
  let maxRep = '';
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 5) continue;
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');

    const date = toIsoDate(get(cDate));
    const dateRep = toIsoDate(get(cDateRep));
    if (date && date > maxDate) maxDate = date;
    if (dateRep && dateRep > maxRep) maxRep = dateRep;

    const dateOk = date && date >= sinceIso;
    const repOk = dateRep && dateRep >= sinceIso;
    if (!dateOk && !repOk) continue;

    const titre = get(cTitre);
    if (!titre) continue;

    const nom = [get(cPrenom), get(cNom)].filter(Boolean).join(' ').trim();
    const ministere = (dateRep ? get(cMinRep) : '') || get(cMinDepot) || undefined;

    const natureRaw = get(cNature).toUpperCase();
    const sousType = /QOSD|ORALE\s+SANS/.test(natureRaw)
      ? 'QOSD'
      : /QG|GOUVERNEMENT/.test(natureRaw)
        ? 'QG'
        : /QC|CRISE/.test(natureRaw)
          ? 'QC'
          : 'QE';

    items.push({
      source: 'senat',
      sous_type: sousType,
      titre,
      auteur: nom || undefined,
      groupe: get(cGroupe) || undefined,
      ministere,
      rubrique: get(cRub) || undefined,
      date,
      date_reponse: dateRep,
      a_reponse: !!dateRep,
      url: get(cUrl) || 'https://www.senat.fr/questions/',
    });
  }
  console.log(`[veille] senat-questions: ${items.length} in window (latest dépôt ${maxDate || 'n/a'}, latest réponse ${maxRep || 'n/a'})`);
  return items;
}

const AN_QUESTION_ZIPS: Array<[string, string]> = [
  ['QG', 'http://data.assemblee-nationale.fr/static/openData/repository/17/questions/questions_gouvernement/Questions_gouvernement.json.zip'],
  ['QOSD', 'http://data.assemblee-nationale.fr/static/openData/repository/17/questions/questions_orales_sans_debat/Questions_orales_sans_debat.json.zip'],
  ['QE', 'http://data.assemblee-nationale.fr/static/openData/repository/17/questions/questions_ecrites/Questions_ecrites.json.zip'],
];

/** Unwrap AN's frequent "either object or array of objects" nesting. */
function firstObj(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) return (v[0] ?? undefined) as Record<string, unknown> | undefined;
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  return undefined;
}

function asStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v) && typeof v[0] === 'string') return (v[0] as string).trim() || undefined;
  return undefined;
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract a normalized ParliamentItem from one AN "question" object. */
function parseAnQuestion(q: Record<string, unknown>): ParliamentItem | undefined {
  const uid = asStr(q.uid);
  const type = (asStr(q.type) ?? '').toUpperCase();
  const sousType = type === 'QG' ? 'QG' : type === 'QOSD' ? 'QOSD' : 'QE';

  const indexation = firstObj(q.indexationAN);
  const rubrique = asStr(indexation?.rubrique);
  let titre = asStr(firstObj(indexation?.analyses)?.analyse) ?? asStr(indexation?.teteAnalyse);

  const tq = firstObj(firstObj(q.textesQuestion)?.texteQuestion);
  const tr = firstObj(firstObj(q.textesReponse)?.texteReponse);
  if (!titre) titre = stripHtml(asStr(tq?.texte))?.slice(0, 180);
  if (!titre) return undefined;

  const minAttrib = firstObj(firstObj(q.minAttribs)?.minAttrib);
  const dateDepot =
    asStr(firstObj(tq?.infoJO)?.dateJO) ?? asStr(firstObj(minAttrib?.infoJO)?.dateJO);
  const dateReponse = asStr(firstObj(tr?.infoJO)?.dateJO);

  const groupe = asStr(firstObj(firstObj(q.auteur)?.groupe)?.abrege);
  const ministere = asStr(firstObj(q.minInt)?.developpe);

  return {
    source: 'an',
    sous_type: sousType,
    titre,
    auteur: undefined,
    groupe,
    ministere,
    rubrique,
    date: dateDepot,
    date_reponse: dateReponse,
    a_reponse: !!dateReponse,
    url: uid
      ? `https://www.assemblee-nationale.fr/dyn/17/questions/${uid}`
      : 'https://www2.assemblee-nationale.fr/recherche/resultats_questions',
  };
}

/** Fetch Assemblée nationale questions (QG/QOSD/QE) from open-data zip archives. */
export async function fetchAnQuestions(sinceIso: string): Promise<ParliamentItem[]> {
  const items: ParliamentItem[] = [];
  const dec = new TextDecoder('utf-8');

  for (const [kind, url] of AN_QUESTION_ZIPS) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'moltbot-veille' } });
      if (!resp.ok) {
        console.warn(`[veille] AN ${kind} zip HTTP ${resp.status} — skipping`);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const files = unzipSync(buf);
      const jsonNames = Object.keys(files).filter((n) => n.toLowerCase().endsWith('.json'));

      let kept = 0;
      let maxDate = '';
      for (const name of jsonNames) {
        let q: Record<string, unknown> | undefined;
        try {
          const parsed = JSON.parse(dec.decode(files[name])) as Record<string, unknown>;
          q = firstObj(parsed.question) ?? parsed;
        } catch {
          continue;
        }
        const item = parseAnQuestion(q);
        if (!item) continue;
        const d = item.date && item.date > '' ? item.date : '';
        if (d > maxDate) maxDate = d;
        const depOk = item.date && item.date >= sinceIso;
        const repOk = item.date_reponse && item.date_reponse >= sinceIso;
        if (!depOk && !repOk) continue;
        items.push(item);
        kept++;
      }
      console.log(`[veille] an-${kind}: ${kept}/${jsonNames.length} in window (latest ${maxDate || 'n/a'})`);
    } catch (err) {
      console.warn(`[veille] AN ${kind} failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  return items;
}

/**
 * Downloads the first reachable AN open-data zip from a candidate list and
 * returns the decompressed file map. Logs which URL won so the runtime loop can
 * pin the correct path from the Action logs.
 */
async function fetchAnZip(
  label: string,
  candidateUrls: string[],
): Promise<Record<string, Uint8Array> | null> {
  for (const url of candidateUrls) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'moltbot-veille' } });
      if (!resp.ok) {
        console.warn(`[veille] AN ${label} zip HTTP ${resp.status} @ ${url}`);
        continue;
      }
      const buf = new Uint8Array(await resp.arrayBuffer());
      const files = unzipSync(buf);
      const names = Object.keys(files);
      console.log(`[veille] AN ${label}: zip OK @ ${url} (${names.length} file(s))`);
      console.log(`[veille] AN ${label}: sample files: ${names.slice(0, 3).join(', ')}`);
      return files;
    } catch (err) {
      console.warn(`[veille] AN ${label} zip failed @ ${url}:`, err instanceof Error ? err.message : String(err));
    }
  }
  console.warn(`[veille] AN ${label}: no candidate URL worked — skipping`);
  return null;
}

/** Recursively pull the first non-empty string found under any of `keys`. */
function deepStr(obj: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || obj == null) return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = deepStr(v, keys, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    for (const v of Object.values(rec)) {
      const r = deepStr(v, keys, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

let _anSampleDumped: Record<string, boolean> = {};
/** One-shot: log the top-level shape of the first entry to confirm schema in logs. */
function dumpAnSample(label: string, root: unknown): void {
  if (_anSampleDumped[label]) return;
  _anSampleDumped[label] = true;
  try {
    const top = root && typeof root === 'object' ? Object.keys(root as object) : typeof root;
    console.log(`[veille] AN ${label} sample top-level keys: ${JSON.stringify(top)}`);
    const inner = firstObj((root as Record<string, unknown>)?.[Object.keys(root as object)[0]]);
    if (inner) console.log(`[veille] AN ${label} sample inner keys: ${JSON.stringify(Object.keys(inner)).slice(0, 400)}`);
  } catch {
    /* best effort */
  }
}

/**
 * Fetch AN amendements (legislature 17). One JSON file per amendment in the zip
 * (very large archive, ~100k entries). Keeps only those deposited on/after
 * sinceIso. Title is synthesized from the targeted text + sort + dispositif snippet.
 */
export async function fetchAnAmendements(sinceIso: string): Promise<ParliamentItem[]> {
  const files = await fetchAnZip('amendements', [
    'http://data.assemblee-nationale.fr/static/openData/repository/17/loi/amendements_legis/Amendements.json.zip',
    'http://data.assemblee-nationale.fr/static/openData/repository/17/amendements/Amendements.json.zip',
    'http://data.assemblee-nationale.fr/static/openData/repository/17/loi/amendements/Amendements.json.zip',
  ]);
  if (!files) return [];

  const dec = new TextDecoder('utf-8');
  const items: ParliamentItem[] = [];
  let kept = 0;
  let maxDate = '';
  for (const name of Object.keys(files)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(dec.decode(files[name])) as Record<string, unknown>;
    } catch {
      continue;
    }
    dumpAnSample('amendements', root);
    const a = firstObj(root.amendement) ?? root;

    const cycle = firstObj(a.cycleDeVie);
    const dateDepot =
      asStr(cycle?.dateDepot) ?? asStr(cycle?.datePublication) ?? deepStr(cycle, ['dateDepot', 'dateSort']);
    if (dateDepot && dateDepot > maxDate) maxDate = dateDepot;
    if (!dateDepot || dateDepot < sinceIso) continue;

    const numero = asStr(a.numero) ?? asStr(a.numeroLong);
    const texteRef = asStr(a.texteLegislatifRef) ?? asStr(a.texteLegislatif);
    const auteur =
      deepStr(a.signataires, ['libelle', 'auteurLibelle']) ?? deepStr(a.signataires, ['texte']);
    const sort = deepStr(cycle?.sort, ['libelle']) ?? deepStr(cycle, ['etatLibelle']);
    const expose = stripHtml(deepStr(a.corps, ['exposeSommaire', 'expose']));
    const dispositif = stripHtml(deepStr(a.corps, ['dispositif', 'contenuAuteur']));
    const snippet = (expose ?? dispositif ?? '').slice(0, 160);

    const titreParts = [
      texteRef ? `Texte ${texteRef}` : null,
      numero ? `amdt n°${numero}` : null,
      sort ? `(${sort})` : null,
    ].filter(Boolean);
    const titre = [titreParts.join(' '), snippet].filter(Boolean).join(' — ') || `Amendement ${name}`;

    items.push({
      source: 'an',
      sous_type: 'amendement',
      titre,
      auteur,
      ministere: undefined,
      rubrique: undefined,
      date: dateDepot,
      a_reponse: false,
      url:
        texteRef && numero
          ? `https://www.assemblee-nationale.fr/dyn/17/amendements/${texteRef}/AN/${numero}`
          : 'https://www.assemblee-nationale.fr/dyn/recherche/amendements',
      texte: expose ?? dispositif,
    });
    kept++;
  }
  console.log(`[veille] an-amendements: ${kept} in window (latest dépôt ${maxDate || 'n/a'})`);
  return items;
}

/**
 * Fetch AN legislative dossiers. The archive typically holds one large JSON with
 * all dossiers; we filter on the latest-activity date being on/after sinceIso.
 */
export async function fetchAnDossiers(sinceIso: string): Promise<ParliamentItem[]> {
  const files = await fetchAnZip('dossiers', [
    'http://data.assemblee-nationale.fr/static/openData/repository/17/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip',
    'http://data.assemblee-nationale.fr/static/openData/repository/17/loi/dossiers_legislatifs/Dossiers_legislatifs.json.zip',
  ]);
  if (!files) return [];

  const dec = new TextDecoder('utf-8');
  // Collect dossier objects whether the archive is one-file-per-dossier or a
  // single bundle under export.dossiersLegislatifs.dossier[].
  const dossiers: Record<string, unknown>[] = [];
  for (const name of Object.keys(files)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(dec.decode(files[name])) as Record<string, unknown>;
    } catch {
      continue;
    }
    dumpAnSample('dossiers', root);
    const single = firstObj(root.dossierParlementaire) ?? firstObj(root.dossier);
    if (single) {
      dossiers.push(single);
      continue;
    }
    const bundle = firstObj(firstObj(root.export)?.dossiersLegislatifs)?.dossier;
    if (Array.isArray(bundle)) {
      for (const d of bundle) if (d && typeof d === 'object') dossiers.push(d as Record<string, unknown>);
    }
  }

  const items: ParliamentItem[] = [];
  let kept = 0;
  let maxDate = '';
  for (const d of dossiers) {
    const titreChemin = asStr(d.titreChemin) ?? deepStr(d, ['titreChemin']);
    const titre = deepStr(firstObj(d.titreDossier), ['titre']) ?? deepStr(d, ['titre']);
    if (!titre) continue;
    const dActivite =
      deepStr(d, ['dateDerniereActivite', 'dateActualisation', 'dateDepot', 'datePublication'])?.slice(0, 10);
    if (dActivite && dActivite > maxDate) maxDate = dActivite;
    if (!dActivite || dActivite < sinceIso) continue;

    items.push({
      source: 'an',
      sous_type: 'dossier',
      titre,
      rubrique: deepStr(d, ['procedureLibelle', 'libelleProcedure']),
      date: dActivite,
      a_reponse: false,
      url: titreChemin
        ? `https://www.assemblee-nationale.fr/dyn/17/dossiers/${titreChemin}`
        : 'https://www.assemblee-nationale.fr/dyn/17/dossiers',
    });
    kept++;
  }
  console.log(`[veille] an-dossiers: ${kept}/${dossiers.length} in window (latest ${maxDate || 'n/a'})`);
  return items;
}

/** Fetch AN public scrutins (votes). One JSON per scrutin in the archive. */
export async function fetchAnScrutins(sinceIso: string): Promise<ParliamentItem[]> {
  const files = await fetchAnZip('scrutins', [
    'http://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip',
    'http://data.assemblee-nationale.fr/static/openData/repository/17/scrutins/Scrutins.json.zip',
  ]);
  if (!files) return [];

  const dec = new TextDecoder('utf-8');
  const items: ParliamentItem[] = [];
  let kept = 0;
  let maxDate = '';
  for (const name of Object.keys(files)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(dec.decode(files[name])) as Record<string, unknown>;
    } catch {
      continue;
    }
    dumpAnSample('scrutins', root);
    const s = firstObj(root.scrutin) ?? root;

    const numero = asStr(s.numero);
    const date = deepStr(s, ['dateScrutin', 'date'])?.slice(0, 10);
    if (date && date > maxDate) maxDate = date;
    if (!date || date < sinceIso) continue;

    const titre = deepStr(s, ['titre', 'objet', 'libelle']);
    if (!titre) continue;
    const sort = deepStr(firstObj(s.sort), ['code', 'libelle']);

    items.push({
      source: 'an',
      sous_type: 'scrutin',
      titre: sort ? `${titre} — ${sort}` : titre,
      date,
      a_reponse: false,
      url: numero
        ? `https://www.assemblee-nationale.fr/dyn/17/scrutins/${numero}`
        : 'https://www.assemblee-nationale.fr/dyn/scrutins',
    });
    kept++;
  }
  console.log(`[veille] an-scrutins: ${kept} in window (latest ${maxDate || 'n/a'})`);
  return items;
}

/**
 * Fetch Sénat legislative dossiers + PPL. Sénat exposes these as CSV under its
 * open-data tree (like the questions feed). Candidate URLs are tried in order;
 * the working one is logged so it can be pinned from the Action logs.
 */
export async function fetchSenatDosleg(sinceIso: string): Promise<ParliamentItem[]> {
  const candidates = [
    'https://data.senat.fr/data/dosleg/dosleg.csv',
    'https://data.senat.fr/data/dosleg/dossiers-legislatifs.csv',
    'https://data.senat.fr/data/dosleg/ppl.csv',
  ];

  const items: ParliamentItem[] = [];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'moltbot-veille' } });
      if (!resp.ok) {
        console.warn(`[veille] Sénat dosleg HTTP ${resp.status} @ ${url}`);
        continue;
      }
      const buf = await resp.arrayBuffer();
      const text = new TextDecoder('latin1').decode(buf);
      const rows = parseCsv(text, ';');
      if (rows.length < 2) {
        console.warn(`[veille] Sénat dosleg @ ${url}: ${rows.length} row(s) — skipping`);
        continue;
      }
      const headers = rows[0];
      console.log(`[veille] Sénat dosleg @ ${url}: ${rows.length} rows, headers: ${headers.join(' | ').slice(0, 300)}`);
      const cTitre = findCol(headers, ['titre'], ['intitule'], ['objet']);
      const cDate = findCol(headers, ['date', 'derniere'], ['datedepot'], ['date']);
      const cUrl = findCol(headers, ['url'], ['lien']);
      const isPpl = /ppl/i.test(url);

      let kept = 0;
      let maxDate = '';
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx].trim() : '');
        const date = toIsoDate(get(cDate));
        if (date && date > maxDate) maxDate = date;
        if (!date || date < sinceIso) continue;
        const titre = get(cTitre);
        if (!titre) continue;
        items.push({
          source: 'senat',
          sous_type: isPpl ? 'ppl' : 'dossier',
          titre,
          date,
          a_reponse: false,
          url: get(cUrl) || 'https://www.senat.fr/dossiers-legislatifs/',
        });
        kept++;
      }
      console.log(`[veille] senat-dosleg @ ${url}: ${kept} in window (latest ${maxDate || 'n/a'})`);
    } catch (err) {
      console.warn(`[veille] Sénat dosleg @ ${url} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return items;
}

// PISTE / Légifrance credentials (cabinet Voxa own API account).
const PISTE_CLIENT_ID = process.env.PISTE_CLIENT_ID ?? '182f04c3-cf27-43ec-8d71-af20929fb0d0';
const PISTE_CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET ?? '9ba8ba82-ab61-43b6-9da4-91071f871d5f';

async function pisteToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: PISTE_CLIENT_ID,
    client_secret: PISTE_CLIENT_SECRET,
    scope: 'openid',
  });
  const resp = await fetch('https://oauth.piste.gouv.fr/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) throw new Error(`PISTE oauth HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('PISTE oauth: no access_token');
  return data.access_token;
}

/**
 * Fetch recent JORF entries (focus: nominations) via the Légifrance search API.
 * First-run debug: dumps the raw response shape to confirm the schema.
 */
export async function fetchJorf(sinceIso: string): Promise<ParliamentItem[]> {
  const token = await pisteToken();

  const payload = {
    recherche: {
      champs: [
        {
          typeChamp: 'ALL',
          criteres: [{ typeRecherche: 'UN_DES_MOTS', valeur: 'nomination', operateur: 'ET' }],
          operateur: 'ET',
        },
      ],
      filtres: [{ facette: 'DATE_PUBLICATION', dates: { start: sinceIso, end: isoDaysAgo(0) } }],
      pageNumber: 1,
      pageSize: 50,
      operateur: 'ET',
      sort: 'PUBLICATION_DATE_DESC',
      typePagination: 'DEFAUT',
    },
    fond: 'JORF',
  };

  const resp = await fetch('https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`JORF search HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

  const data = (await resp.json()) as {
    results?: Array<{
      titles?: Array<{ id?: string; cid?: string; title?: string }>;
      nature?: string;
      datePublication?: string;
      nor?: string;
    }>;
  };

  const items: ParliamentItem[] = [];
  for (const res of data.results ?? []) {
    const t = res.titles?.[0];
    const titre = stripHtml(t?.title);
    if (!titre) continue;
    const date = res.datePublication ? res.datePublication.slice(0, 10) : undefined;
    const cid = t?.cid ?? t?.id?.split('_')[0];
    items.push({
      source: 'jorf',
      sous_type: 'nomination',
      titre,
      rubrique: res.nature ?? undefined,
      ministere: res.nor ?? undefined,
      date,
      a_reponse: false,
      url: cid ? `https://www.legifrance.gouv.fr/jorf/id/${cid}` : 'https://www.legifrance.gouv.fr/jorf/jo',
    });
  }
  console.log(`[veille] jorf: ${items.length} nomination(s) since ${sinceIso}`);
  return items;
}

/**
 * Fetches all configured parliamentary sources.
 *
 * Sénat CSV is refreshed live (dual-date, often future-dated réponses), so it
 * uses the short window. The AN static open-data dumps lag ~6 days, so AN uses
 * a wider window to surface recent items despite the publication delay.
 */
export async function fetchParliamentItems(sinceIso: string): Promise<ParliamentItem[]> {
  const all: ParliamentItem[] = [];
  const anSince = isoDaysAgo(8); // AN dump lags ~6 days

  const sources: Array<[string, () => Promise<ParliamentItem[]>]> = [
    ['senat-questions', () => fetchSenatQuestions(sinceIso)],
    ['senat-dosleg', () => fetchSenatDosleg(sinceIso)],
    ['an-questions', () => fetchAnQuestions(anSince)],
    ['an-amendements', () => fetchAnAmendements(anSince)],
    ['an-dossiers', () => fetchAnDossiers(anSince)],
    ['an-scrutins', () => fetchAnScrutins(anSince)],
    ['jorf', () => fetchJorf(sinceIso)],
  ];

  for (const [name, fn] of sources) {
    try {
      const items = await fn();
      console.log(`[veille] parliament source ${name}: ${items.length} item(s)`);
      all.push(...items);
    } catch (err) {
      console.warn(
        `[veille] parliament source ${name} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return all;
}

/** Returns the ISO date `days` days before today (Paris-agnostic, UTC date math). */
export function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Paris weekday (1=Mon … 7=Sun) to widen the window over the weekend on Mondays. */
export function parisWeekday(): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    weekday: 'short',
  }).format(new Date());
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd] ?? 1;
}
