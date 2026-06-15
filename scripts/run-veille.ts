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
import { preAnalyzeEmailRelevance } from '../src/veille/pre-analyze';
import {
  fetchParliamentItems,
  isoDaysAgo,
  parisWeekday,
} from '../src/veille/parliament-fetch';
import { analyzeParliamentForClient } from '../src/veille/parliament-analyze';
import { sendBulletinToSlack, sendDmToUser } from '../src/veille/slack';
import type { ParliamentData } from '../src/veille/types';

const ADMIN_USER = process.env.VEILLE_ADMIN_SLACK_USER ?? 'U0AFT8CK7BR';

async function main() {
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

  // Fetch parliamentary open data directly (autonomous — no Voxa server dependency).
  // Monday widens the window to 3 days to cover the weekend.
  const parliamentMap = new Map<string, ParliamentData>();
  const lookbackDays = parisWeekday() === 1 ? 3 : 1;
  console.log(`[veille] Fetching parliamentary open data (lookback ${lookbackDays}d)...`);
  const parliamentItems = await fetchParliamentItems(isoDaysAgo(lookbackDays)).catch((err) => {
    console.warn('[veille] parliament fetch failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return [];
  });
  console.log(`[veille] ${parliamentItems.length} parliamentary item(s) in window`);

  console.log('[veille] Fetching emails via IMAP...');
  let emails: Awaited<ReturnType<typeof fetchImapEmails>>;

  try {
    emails = await fetchImapEmails(gmailUser!, gmailPass!);
    console.log(`[veille] ${emails.length} emails fetched`);
  } catch (err) {
    const msg = err instanceof Error
      ? `${err.message}${err.cause ? ` | cause: ${err.cause}` : ''}${(err as NodeJS.ErrnoException).code ? ` | code: ${(err as NodeJS.ErrnoException).code}` : ''}`
      : String(err);
    console.error('[veille] IMAP fetch failed:', msg);
    console.error('[veille] Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)));
    await sendDmToUser(ADMIN_USER, `⚠️ Veille mail — Échec IMAP : ${msg}`, botToken!);
    process.exit(1);
  }

  const keywordTagged = tagEmailsByClient(emails, CLIENTS);

  // Pre-analysis: thematic routing via Claude Haiku (fast, cheap, catches contextual relevance)
  console.log('[veille] Running thematic pre-analysis...');
  const preMap = await preAnalyzeEmailRelevance(emails, CLIENTS, apiKey!).catch((err) => {
    console.warn('[veille] pre-analyze failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return new Map<number, string[]>();
  });

  // Merge: add any clients suggested by pre-analysis not already caught by keywords
  let preAdditions = 0;
  const taggedEmails = keywordTagged.map((email) => {
    const suggested = preMap.get(email.num) ?? [];
    const newClients = suggested.filter((id) => !email.matched_clients.includes(id));
    if (newClients.length === 0) return email;
    preAdditions++;
    return {
      ...email,
      matched_clients: [...email.matched_clients, ...newClients],
      matched_keywords: [...email.matched_keywords, '[pré-analyse thématique]'],
    };
  });

  console.log(`[veille] pre-analyze: ${preAdditions} additional email-client tag(s) added`);
  for (const client of CLIENTS) {
    const count = taggedEmails.filter((e) => e.matched_clients.includes(client.client_id)).length;
    console.log(`[veille] ${client.client_id}: ${count} email(s) tagged`);
  }

  // Optional single-client mode (validation / targeted reruns).
  // VEILLE_ONLY_CLIENT=sodiaal limits analysis + Slack posting to one client.
  const onlyClient = process.env.VEILLE_ONLY_CLIENT?.trim() || '__none__';
  const activeClients = onlyClient
    ? CLIENTS.filter((c) => c.client_id === onlyClient)
    : CLIENTS;
  if (onlyClient) {
    console.log(`[veille] ONLY_CLIENT mode: ${onlyClient} (${activeClients.length} client)`);
  }

  // Stagger Claude API calls to stay under 30k tokens/min rate limit.
  // For each client: email analysis + parliamentary analysis.
  const analyses: PromiseSettledResult<Awaited<ReturnType<typeof analyzeClientEmails>>>[] = [];
  for (const client of activeClients) {
    analyses.push(await Promise.resolve(analyzeClientEmails(client, taggedEmails, apiKey!)).then(
      (v) => ({ status: 'fulfilled' as const, value: v }),
      (r) => ({ status: 'rejected' as const, reason: r }),
    ));

    // Parliamentary analysis (non-fatal — never blocks the email bulletin)
    try {
      const parl = await analyzeParliamentForClient(client, parliamentItems, apiKey!);
      parliamentMap.set(client.client_id, parl);
      console.log(`[veille] parliament ${client.client_id}: ${parl.signal_count} signal(s)`);
    } catch (err) {
      console.warn(`[veille] parliament analysis failed for ${client.client_id}:`, err instanceof Error ? err.message : String(err));
    }

    await new Promise((res) => setTimeout(res, 20000));
  }

  const errors: string[] = [];

  for (let i = 0; i < activeClients.length; i++) {
    const client = activeClients[i];
    const settlement = analyses[i];

    if (settlement.status === 'rejected') {
      const msg = String(settlement.reason);
      errors.push(`${client.client_id} analysis: ${msg}`);
      console.error(`[veille] Analysis failed for ${client.client_id}:`, msg);
      continue;
    }

    const bulletin = settlement.value;

    // Attach parliamentary data if available
    const parliament = parliamentMap.get(client.client_id);
    if (parliament) bulletin.parliament = parliament;

    try {
      const ts = await sendBulletinToSlack(bulletin, client.slack_channel_id, botToken!);
      const parl = bulletin.parliament ? ` + ${bulletin.parliament.signal_count} parl` : '';
      console.log(
        `[veille] Sent ${client.client_id} (${bulletin.ras ? 'RAS' : `${bulletin.signaux.length} signals`}${parl})${ts ? ` ts=${ts}` : ''}`,
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
