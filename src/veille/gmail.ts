import type { ParsedEmail, TaggedEmail, ClientConfig } from './types';

export async function fetchGmailExport(webappUrl: string, key: string): Promise<string> {
  const url = `${webappUrl}?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Voxa-Veille/1.0' },
  });

  if (!response.ok) {
    throw new Error(`Gmail Web App responded ${response.status}: ${await response.text().catch(() => '')}`);
  }

  const text = await response.text();
  if (text.includes('Unauthorized') || text.includes('Error')) {
    throw new Error(`Gmail Web App auth error: ${text.slice(0, 200)}`);
  }

  return text;
}

export function parseEmails(rawText: string): ParsedEmail[] {
  const emails: ParsedEmail[] = [];

  // Split on separator lines (5+ dashes on their own line)
  const blocks = rawText.split(/\n-{5,}\n/).map((b) => b.trim()).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split('\n');

    // First line must be "EMAIL #n"
    const headerMatch = lines[0]?.match(/EMAIL\s+#?(\d+)/i);
    if (!headerMatch) continue;

    const num = parseInt(headerMatch[1], 10);
    const meta: Record<string, string> = {};
    let bodyStart = 1;

    // Parse key: value metadata until blank line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        bodyStart = i + 1;
        break;
      }
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const k = line.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, '_');
        const v = line.slice(colonIdx + 1).trim();
        meta[k] = v;
      }
    }

    const body = lines.slice(bodyStart).join('\n').slice(0, 6000);

    emails.push({
      num,
      date: meta.date ?? meta.from_date ?? meta.date_envoi ?? '',
      sender: meta.from ?? meta.de ?? meta.sender ?? meta.expediteur ?? '',
      subject: meta.subject ?? meta.objet ?? meta.sujet ?? '',
      body,
    });
  }

  return emails;
}

export function tagEmailsByClient(
  emails: ParsedEmail[],
  clients: ClientConfig[],
): TaggedEmail[] {
  return emails.map((email) => {
    const searchText = [email.subject, email.body, email.sender].join(' ').toLowerCase();
    const matched_clients: string[] = [];
    const all_matched_keywords: string[] = [];

    for (const client of clients) {
      const hits: string[] = [];

      for (const kw of client.mots_cles) {
        if (searchText.includes(kw.toLowerCase())) {
          hits.push(kw);
        }
      }

      for (const actor of client.acteurs_suivis) {
        // Match on last name (≥4 chars) to avoid false positives on short names
        const lastName = actor.split(' ').pop() ?? '';
        if (lastName.length >= 4 && searchText.includes(lastName.toLowerCase())) {
          hits.push(actor);
        }
      }

      if (hits.length > 0) {
        matched_clients.push(client.client_id);
        all_matched_keywords.push(...hits);
      }
    }

    return { ...email, matched_clients, matched_keywords: all_matched_keywords };
  });
}
