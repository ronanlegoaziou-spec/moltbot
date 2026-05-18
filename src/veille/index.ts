import { CLIENTS } from './clients';
import { fetchGmailExport, parseEmails, tagEmailsByClient } from './gmail';
import { fetchGmailApiEmails, isGmailApiConfigured } from './gmail-api';
import { analyzeClientEmails } from './analyze';
import { sendBulletinToSlack, sendDmToUser } from './slack';
import type { VeilleRunResult } from './types';

export type { VeilleRunResult } from './types';

export interface VeilleEnv {
  ANTHROPIC_API_KEY?: string;
  VEILLE_SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  VEILLE_WEBAPP_URL?: string;
  VEILLE_WEBAPP_KEY?: string;
  VEILLE_ADMIN_SLACK_USER?: string;
  // Gmail API fallback (optional — used when Google Apps Script is unavailable)
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
}

// Ronan's Slack user ID — receives DM on infra errors (never on client channels)
const DEFAULT_ADMIN_USER = 'U0AFT8CK7BR';

function isParisTimeBetween(fromH: number, fromM: number, toH: number, toM: number): boolean {
  const now = new Date();
  // Extract Paris local time
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const total = h * 60 + m;
  return total >= fromH * 60 + fromM && total <= toH * 60 + toM;
}

/**
 * Returns true if the current Paris time is in the 8:00–8:30 window.
 * Used to deduplicate across the two UTC crons (06:15 + 07:15) that cover
 * CEST (UTC+2, summer) and CET (UTC+1, winter).
 */
export function isVeilleWindow(): boolean {
  return isParisTimeBetween(8, 0, 8, 30);
}

export async function runVeilleMail(env: VeilleEnv): Promise<VeilleRunResult> {
  const result: VeilleRunResult = {
    date: new Date().toISOString(),
    total_emails: 0,
    bulletins: [],
    errors: [],
  };

  const botToken = env.VEILLE_SLACK_BOT_TOKEN ?? env.SLACK_BOT_TOKEN;
  const adminUser = env.VEILLE_ADMIN_SLACK_USER ?? DEFAULT_ADMIN_USER;

  const hasAppsScript = !!(env.VEILLE_WEBAPP_URL && env.VEILLE_WEBAPP_KEY);
  const hasGmailApi = isGmailApiConfigured(env);

  const missingVars: string[] = [];
  if (!hasAppsScript && !hasGmailApi) missingVars.push('VEILLE_WEBAPP_URL+VEILLE_WEBAPP_KEY or GMAIL_*');
  if (!env.ANTHROPIC_API_KEY) missingVars.push('ANTHROPIC_API_KEY');
  if (!botToken) missingVars.push('VEILLE_SLACK_BOT_TOKEN or SLACK_BOT_TOKEN');

  if (missingVars.length > 0) {
    const msg = `Veille mail non configurée — secrets manquants : ${missingVars.join(', ')}`;
    result.errors.push(msg);
    console.error('[veille]', msg);
    return result;
  }

  // Step 1 — Fetch emails: try Google Apps Script first, fall back to Gmail API
  let emails: Awaited<ReturnType<typeof parseEmails>>;
  try {
    if (hasAppsScript) {
      console.log('[veille] Fetching Gmail via Apps Script...');
      const raw = await fetchGmailExport(env.VEILLE_WEBAPP_URL!, env.VEILLE_WEBAPP_KEY!);
      console.log(`[veille] Apps Script export: ${raw.length} chars`);
      emails = parseEmails(raw);
    } else {
      throw new Error('Apps Script not configured');
    }
  } catch (appsScriptErr) {
    if (hasGmailApi) {
      console.log('[veille] Apps Script failed, trying Gmail API fallback...');
      try {
        emails = await fetchGmailApiEmails(env);
        console.log(`[veille] Gmail API fallback: ${emails.length} emails`);
      } catch (apiErr) {
        const msg = `Gmail API: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`;
        result.errors.push(msg);
        console.error('[veille]', msg);
        await sendDmToUser(adminUser, `⚠️ Veille mail — Échec Gmail (Apps Script + API) : ${msg}`, botToken!);
        return result;
      }
    } else {
      const msg = appsScriptErr instanceof Error ? appsScriptErr.message : String(appsScriptErr);
      result.errors.push(`Gmail fetch: ${msg}`);
      console.error('[veille] Gmail fetch error:', msg);
      await sendDmToUser(adminUser, `⚠️ Veille mail — Échec récupération Gmail : ${msg}`, botToken!);
      return result;
    }
  }
  result.total_emails = emails.length;
  console.log(`[veille] ${emails.length} emails parsed`);

  const taggedEmails = tagEmailsByClient(emails, CLIENTS);
  for (const client of CLIENTS) {
    const count = taggedEmails.filter((e) => e.matched_clients.includes(client.client_id)).length;
    console.log(`[veille] ${client.client_id}: ${count} email(s) tagged`);
  }

  // Step 3 — Analyze each client in parallel with Claude
  const analyses = await Promise.allSettled(
    CLIENTS.map((client) =>
      analyzeClientEmails(client, taggedEmails, env.ANTHROPIC_API_KEY!),
    ),
  );

  // Step 4 — Send bulletins to Slack
  for (let i = 0; i < CLIENTS.length; i++) {
    const client = CLIENTS[i];
    const settlement = analyses[i];

    if (settlement.status === 'rejected') {
      const msg = String(settlement.reason);
      result.errors.push(`${client.client_id} analysis: ${msg}`);
      console.error(`[veille] Analysis failed for ${client.client_id}:`, msg);
      continue;
    }

    const bulletin = settlement.value;
    result.bulletins.push(bulletin);

    try {
      const ts = await sendBulletinToSlack(bulletin, client.slack_channel_id, botToken!);
      console.log(
        `[veille] Slack sent for ${client.client_id} (${bulletin.ras ? 'RAS' : `${bulletin.signaux.length} signals`})${ts ? ` ts=${ts}` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${client.client_id} slack: ${msg}`);
      console.error(`[veille] Slack error for ${client.client_id}:`, msg);
    }
  }

  console.log(
    `[veille] Run complete — ${result.total_emails} emails, ${result.bulletins.length} bulletins, ${result.errors.length} errors`,
  );
  return result;
}
