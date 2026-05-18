import type { TaggedEmail, ClientConfig, ClientBulletin, ClientSignal } from './types';

interface ClaudeAnalysis {
  synthese: string;
  signaux: ClientSignal[];
  agenda: string[];
}

function todayParis(): string {
  return new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris',
  });
}

export async function analyzeClientEmails(
  client: ClientConfig,
  emails: TaggedEmail[],
  anthropicApiKey: string,
): Promise<ClientBulletin> {
  const date = todayParis();
  const clientEmails = emails.filter((e) => e.matched_clients.includes(client.client_id));

  if (clientEmails.length === 0) {
    return {
      client_id: client.client_id,
      nom_court: client.nom_court,
      date,
      synthese: 'Aucun signal détecté dans les sources email suivies aujourd\'hui.',
      signaux: [],
      agenda: [],
      ras: true,
      emails_count: 0,
    };
  }

  const brief = clientEmails
    .map(
      (e) =>
        `[Email #${e.num}] ${e.date} | De : ${e.sender} | Objet : ${e.subject}\n${e.body}`,
    )
    .join('\n---\n');

  const systemPrompt = `Tu es analyste veille affaires publiques pour le cabinet Voxa.
Tu analyses les emails de la boîte de veille du jour pour le client ${client.nom}.

Secteurs : ${client.secteurs.join(', ')}
Enjeux client : ${client.sujet_instit}
Acteurs suivis : ${client.acteurs_suivis.join(', ')}
Mots-clés de veille : ${client.mots_cles.join(', ')}

Règles absolues :
- Ne jamais inventer. Chaque signal doit citer un email précis via email_num.
- Ton factuel et concis. Pas d'emojis dans les champs texte.
- Si aucun signal significatif : synthèse courte "RAS" + signaux vides.
- Recommandations actionnables en 1 phrase.
- Réponds UNIQUEMENT avec du JSON valide, sans markdown ni commentaires.`;

  const userPrompt = `Emails taggés pour ${client.nom_court} (${clientEmails.length} email${clientEmails.length > 1 ? 's' : ''}) :

${brief}

Produis ce JSON exact :
{
  "synthese": "2-3 phrases résumant les signaux du jour pour ${client.nom_court}",
  "signaux": [
    {
      "titre": "Titre court et factuel",
      "niveau": "critique|fort|moyen|faible",
      "description": "Description factuelle, 2-3 phrases max",
      "impact": "Impact direct pour ${client.nom_court} en 1 phrase",
      "recommandation": "Action concrète recommandée en 1 phrase",
      "email_num": 1
    }
  ],
  "agenda": ["Échéance avec date si mentionnée explicitement dans les emails"]
}

Niveaux : critique = vote/décision imminente impact direct, fort = signal majeur acteur ou décision, moyen = information pertinente, faible = signal de fond.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '{}';

  let parsed: Partial<ClaudeAnalysis> = {};
  try {
    parsed = JSON.parse(text) as ClaudeAnalysis;
  } catch {
    console.error(`[veille] JSON parse error for ${client.client_id}:`, text.slice(0, 300));
    parsed = {
      synthese: `Erreur de parsing de la réponse Claude pour ${client.nom_court}.`,
      signaux: [],
      agenda: [],
    };
  }

  return {
    client_id: client.client_id,
    nom_court: client.nom_court,
    date,
    synthese: parsed.synthese ?? '',
    signaux: parsed.signaux ?? [],
    agenda: parsed.agenda ?? [],
    ras: false,
    emails_count: clientEmails.length,
  };
}
