#!/usr/bin/env npx tsx
/**
 * Standalone veille runner for GitHub Actions.
 * Uses Gmail IMAP (App Password) — no Cloudflare Worker dependencies.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY
 *   VEILLE_SLACK_BOT_TOKEN
 *   GMAIL_USER          (e.g. yann@voxagroup.fr)
 *   GMAIL_APP_PASSWORD  (16-char Google App Password, spaces optional)
 *
 * Exits 0 on success or skipped window, 1 on hard failure.
 */

import { CLIENTS } from '../src/veille/clients';
import { tagEmailsByClient } from '../src/veille/gmail';
import { fetchImapEmails } from '../src/veille/gmail-imap';
import { analyzeClientEmails } from '../src/veille/analyze';
import { sendBulletinToSlack, sendDmToUser } from '../src/veille/slack';

const ADMIN_USER = process.env.VEILLE_ADMIN_SLACK_USER ?? 'U0AFT8CK7BR';

function isVeilleWindow(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const total = h * 60 + m;
  return total >= 8 * 60 && total <= 8 * 60 + 30;
}

async function main() {
  // Guard — only run in the 8:00–8:30 Paris window
  if (!isVeilleWindow()) {
    console.log('[veille] Outside 8:00–8:30 Paris window — skipping.');
    process.exit(0);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const botToken = process.env.VEILLE_SLACK_BOT_TOKEN;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');

  const missing: string[] = [];
  if (!apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!botToken) missing.push('VEILLE_SLACK_BOT_TOKEN');
  if (!gmailUser) missing.push('GMAIL_USER');
  if (!gmailPass) missing.push('GMAIL_APP_PASSWORD');

  if (missing.length > 0) {
    console.error(`[veille] Secrets manquants : ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('[veille] Fetching emails via IMAP...');
  let emails: Awaited<ReturnType<typeof fetchImapEmails>>;

  try {
    emails = await fetchImapEmails(gmailUser!, gmailPass!);
    console.log(`[veille] ${emails.length} emails fetched`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[veille] IMAP fetch failed:', msg);
    await sendDmToUser(ADMIN_USER, `⚠️ Veille mail — Échec IMAP : ${msg}`, botToken!);
    process.exit(1);
  }

  const taggedEmails = tagEmailsByClient(emails, CLIENTS);
  for (const client of CLIENTS) {
    const count = taggedEmails.filter((e) => e.matched_clients.includes(client.client_id)).length;
    console.log(`[veille] ${client.client_id}: ${count} email(s) tagged`);
  }

  const analyses = await Promise.allSettled(
    CLIENTS.map((client) => analyzeClientEmails(client, taggedEmails, apiKey!)),
  );

  const errors: string[] = [];

  for (let i = 0; i < CLIENTS.length; i++) {
    const client = CLIENTS[i];
    const settlement = analyses[i];

    if (settlement.status === 'rejected') {
      const msg = String(settlement.reason);
      errors.push(`${client.client_id} analysis: ${msg}`);
      console.error(`[veille] Analysis failed for ${client.client_id}:`, msg);
      continue;
    }

    const bulletin = settlement.value;

    try {
      const ts = await sendBulletinToSlack(bulletin, client.slack_channel_id, botToken!);
      console.log(
        `[veille] Sent ${client.client_id} (${bulletin.ras ? 'RAS' : `${bulletin.signaux.length} signals`})${ts ? ` ts=${ts}` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${client.client_id} slack: ${msg}`);
      console.error(`[veille] Slack error for ${client.client_id}:`, msg);
    }
  }

  if (errors.length > 0) {
    console.warn(`[veille] ${errors.length} error(s):\n${errors.join('\n')}`);
    await sendDmToUser(
      ADMIN_USER,
      `⚠️ Veille mail — ${errors.length} erreur(s) :\n${errors.join('\n')}`,
      botToken!,
    );
  }

  console.log('[veille] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[veille] Fatal:', err);
  process.exit(1);
});
