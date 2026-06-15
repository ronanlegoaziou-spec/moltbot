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
  source: 'senat' | 'an';
  sous_type: string; // QE / QG / QOSD / QC
  titre: string;
  auteur?: string;
  groupe?: string;
  ministere?: string;
  rubrique?: string;
  date?: string; // ISO date of deposit
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
    ['an-questions', () => fetchAnQuestions(anSince)],
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
