import type { ClientConfig, ParliamentData } from './types';
import type { ParliamentItem } from './parliament-fetch';

/** Keyword/actor prefilter: keep items textually relevant to the client. */
function prefilterForClient(items: ParliamentItem[], client: ClientConfig): ParliamentItem[] {
  const needles: string[] = [
    ...client.mots_cles.map((k) => k.toLowerCase()),
    ...client.acteurs_suivis
      .map((a) => a.split(' ').pop() ?? '')
      .filter((n) => n.length >= 4)
      .map((n) => n.toLowerCase()),
  ];

  return items.filter((it) => {
    const hay = [it.titre, it.rubrique, it.auteur, it.ministere].join(' ').toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
}

/**
 * Produces the parliamentary thread message for a client using Claude.
 * Returns null if no relevant items (caller decides whether to post a RAS thread).
 */
export async function analyzeParliamentForClient(
  client: ClientConfig,
  items: ParliamentItem[],
  anthropicApiKey: string,
): Promise<ParliamentData> {
  const date = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris',
  });
  const nowIso = new Date().toISOString();

  const candidates = prefilterForClient(items, client).slice(0, 20);

  if (candidates.length === 0) {
    return {
      client_id: client.client_id,
      date,
      run_at_utc: nowIso,
      has_signals: false,
      signal_count: 0,
      slack_text: '',
    };
  }

  const brief = candidates
    .map((it, i) => {
      const evt = it.a_reponse ? '📨 réponse publiée' : '📝 nouvelle question';
      return `[${i + 1}] (${it.source.toUpperCase()} ${it.sous_type}, ${evt}) ${it.titre}
   Auteur: ${it.auteur ?? '?'}${it.groupe ? ` (${it.groupe})` : ''} | Ministère: ${it.ministere ?? '?'} | Rubrique: ${it.rubrique ?? '?'}
   ${it.url}`;
    })
    .join('\n');

  const systemPrompt = `Tu es analyste veille parlementaire pour le cabinet Voxa, client ${client.nom}.
Secteurs : ${client.secteurs.join(', ')}
Enjeux : ${client.sujet_instit}

Tu reçois des questions parlementaires (AN/Sénat) déposées ou répondues dans les dernières 24-72h, déjà préfiltrées par mots-clés. Sélectionne UNIQUEMENT celles réellement pertinentes pour ${client.nom_court} (écarte les faux positifs). Pour chaque question retenue, écris une ligne Slack mrkdwn concise.`;

  const userPrompt = `Questions candidates pour ${client.nom_court} :

${brief}

Réponds en JSON strict :
{
  "retenues": [
    { "indice": 1, "ligne": "• <url|Titre court> — _auteur, ministère_ · angle d'intérêt pour ${client.nom_court} en quelques mots" }
  ]
}
Garde au maximum 8 lignes, les plus stratégiques. Si aucune n'est pertinente, retenues = [].`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1536,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude parliament ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '{}';
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let retenues: Array<{ ligne: string }> = [];
  try {
    const parsed = JSON.parse(clean) as { retenues?: Array<{ ligne: string }> };
    retenues = parsed.retenues ?? [];
  } catch {
    console.warn(`[veille] parliament JSON parse error for ${client.client_id}:`, clean.slice(0, 200));
  }

  const lines = retenues.map((r) => r.ligne).filter(Boolean);

  if (lines.length === 0) {
    return {
      client_id: client.client_id,
      date,
      run_at_utc: nowIso,
      has_signals: false,
      signal_count: 0,
      slack_text: '',
    };
  }

  const slackText = [
    `🏛️ *Activité parlementaire — ${client.nom_court}*`,
    '',
    ...lines,
    '',
    `_${candidates.length} question(s) parlementaire(s) examinée(s) · source : open data AN/Sénat_`,
  ].join('\n');

  return {
    client_id: client.client_id,
    date,
    run_at_utc: nowIso,
    has_signals: true,
    signal_count: lines.length,
    slack_text: slackText,
  };
}
