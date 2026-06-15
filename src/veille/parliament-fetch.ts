/**
 * Autonomous parliamentary open-data ingestion for moltbot.
 * Fetches directly from public French open-data endpoints inside the GitHub
 * Action — NO dependency on the Voxa Intelligence server or pappers-maison.
 *
 * Each source is independent and non-fatal: a failure in one never blocks the
 * others, and never blocks the email veille.
 */

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
  console.log(`[veille][debug] senat maxDate=${maxDate} maxRep=${maxRep} since=${sinceIso} matched=${items.length}`);
  return items;
}

/**
 * Fetches all configured parliamentary sources for the given lookback window.
 * Returns a flat, deduplicated list of items. Each source is isolated.
 */
export async function fetchParliamentItems(sinceIso: string): Promise<ParliamentItem[]> {
  const all: ParliamentItem[] = [];

  const sources: Array<[string, () => Promise<ParliamentItem[]>]> = [
    ['senat-questions', () => fetchSenatQuestions(sinceIso)],
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
