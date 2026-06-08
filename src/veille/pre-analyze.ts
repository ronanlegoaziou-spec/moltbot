import type { ParsedEmail, ClientConfig } from './types';

interface PreAnalyzeMapping {
  email_num: number;
  client_ids: string[];
  reason: string;
}

/**
 * Fast thematic pre-screening: sends all emails + all client descriptions to
 * Claude Haiku in a single call. Returns a map of email_num → client_ids based
 * on contextual reasoning (not just keyword matching).
 *
 * Non-fatal: returns empty map on any error so keyword tagging still works.
 */
export async function preAnalyzeEmailRelevance(
  emails: ParsedEmail[],
  clients: ClientConfig[],
  anthropicApiKey: string,
): Promise<Map<number, string[]>> {
  if (emails.length === 0) return new Map();

  const emailBrief = emails
    .map((e) => `[#${e.num}] Objet: ${e.subject} | De: ${e.sender}\n${e.body.slice(0, 300)}`)
    .join('\n---\n');

  const clientBrief = clients
    .map((c) => `- ${c.client_id} (${c.nom_court}): ${c.secteurs.join(', ')} — ${c.sujet_instit}`)
    .join('\n');

  const validIds = clients.map((c) => c.client_id).join(', ');

  const prompt = `Tu es analyste veille affaires publiques senior. Voici ${emails.length} emails reçus aujourd'hui et 6 profils clients.

CLIENTS :
${clientBrief}

EMAILS :
${emailBrief}

Pour chaque email, identifie les clients pour lesquels cet email est pertinent par raisonnement thématique. Va au-delà du lexical : une étude sur les centres commerciaux concerne un retailer ET une chaîne de restauration rapide en food court ; une réforme du droit du travail peut toucher plusieurs secteurs. Sois exigeant : ne tague que si le lien est réel et actionnable pour le client.

Réponds UNIQUEMENT avec du JSON valide :
{
  "mappings": [
    { "email_num": 1, "client_ids": ["lidl", "bk_bf"], "reason": "Courte justification en 1 phrase" }
  ]
}

N'inclus dans mappings QUE les emails ayant au moins 1 client pertinent. IDs valides : ${validIds}.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.warn(`[veille] pre-analyze HTTP ${response.status}: ${errText.slice(0, 200)}`);
    return new Map();
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '{}';
  const cleanText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: { mappings?: PreAnalyzeMapping[] } = {};
  try {
    parsed = JSON.parse(cleanText) as { mappings?: PreAnalyzeMapping[] };
  } catch {
    console.warn('[veille] pre-analyze JSON parse error:', cleanText.slice(0, 200));
    return new Map();
  }

  const result = new Map<number, string[]>();
  const validIdSet = new Set(clients.map((c) => c.client_id));

  for (const mapping of parsed.mappings ?? []) {
    if (typeof mapping.email_num !== 'number' || !Array.isArray(mapping.client_ids)) continue;
    const validClients = mapping.client_ids.filter((id) => validIdSet.has(id));
    if (validClients.length === 0) continue;
    result.set(mapping.email_num, validClients);
    console.log(
      `[veille] pre-analyze #${mapping.email_num} → ${validClients.join(', ')} | ${mapping.reason ?? ''}`,
    );
  }

  return result;
}
