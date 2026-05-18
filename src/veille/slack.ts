import type { ClientBulletin } from './types';

const NIVEAU_ICONS: Record<string, string> = {
  critique: '🔴',
  fort: '🟠',
  moyen: '🟡',
  faible: '⚪',
};

function formatBulletin(bulletin: ClientBulletin): string {
  const header = `📬 *Veille mail — ${bulletin.date} — ${bulletin.nom_court}*`;

  if (bulletin.ras) {
    return `${header}\n_Aucun signal dans les sources email suivies aujourd'hui._`;
  }

  const lines: string[] = [header, ''];

  lines.push(`*Synthèse :* ${bulletin.synthese}`);

  if (bulletin.signaux.length > 0) {
    const counts: Record<string, number> = { critique: 0, fort: 0, moyen: 0, faible: 0 };
    for (const s of bulletin.signaux) counts[s.niveau] = (counts[s.niveau] ?? 0) + 1;

    const countParts = (['critique', 'fort', 'moyen', 'faible'] as const)
      .filter((n) => counts[n] > 0)
      .map((n) => `${NIVEAU_ICONS[n]} ${counts[n]} ${n}`);

    lines.push(`*Signaux :* ${countParts.join('  ')}`);
    lines.push('');

    for (const signal of bulletin.signaux) {
      const icon = NIVEAU_ICONS[signal.niveau] ?? '•';
      lines.push(`${icon} *${signal.titre}*`);
      lines.push(`> ${signal.description}`);
      lines.push(`> _Impact :_ ${signal.impact}`);
      lines.push(`> _→_ ${signal.recommandation}`);
      lines.push('');
    }
  }

  if (bulletin.agenda.length > 0) {
    lines.push(`📅 *Agenda :* ${bulletin.agenda.join(' • ')}`);
    lines.push('');
  }

  const n = bulletin.emails_count;
  lines.push(`_${n} email${n > 1 ? 's' : ''} analysé${n > 1 ? 's' : ''} sur 24h_`);

  return lines.join('\n');
}

export async function sendBulletinToSlack(
  bulletin: ClientBulletin,
  channelId: string,
  botToken: string,
): Promise<string | null> {
  const text = formatBulletin(bulletin);
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
  });

  const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };

  if (!data.ok) {
    console.error(`[veille] Slack error (${channelId}): ${data.error}`);
    return null;
  }

  return data.ts ?? null;
}

export async function sendDmToUser(
  userId: string,
  text: string,
  botToken: string,
): Promise<void> {
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel: userId, text }),
    });
  } catch {
    // best effort
  }
}
