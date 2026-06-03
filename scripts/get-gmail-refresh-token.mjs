#!/usr/bin/env node
/**
 * Script pour obtenir un refresh token Gmail API (OAuth 2.0).
 * À exécuter EN LOCAL (pas dans Cloudflare) une seule fois.
 *
 * Prérequis :
 *   1. Avoir un projet Google Cloud avec l'API Gmail activée
 *   2. Avoir créé des identifiants OAuth 2.0 de type "Application de bureau"
 *   3. Définir CLIENT_ID et CLIENT_SECRET en variables d'environnement
 *
 * Usage :
 *   CLIENT_ID=xxx CLIENT_SECRET=xxx node scripts/get-gmail-refresh-token.mjs
 */

import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8085/callback';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  Définissez CLIENT_ID et CLIENT_SECRET en variables d\'environnement.');
  console.error('   Exemple : CLIENT_ID=xxx.apps.googleusercontent.com CLIENT_SECRET=yyy node scripts/get-gmail-refresh-token.mjs');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth' +
  '?response_type=code' +
  '&access_type=offline' +
  '&prompt=consent' +
  `&client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}`;

console.log('\n🔑  Ouverture du navigateur pour autoriser l\'accès Gmail...');
console.log('   Si le navigateur ne s\'ouvre pas, copiez cette URL manuellement :\n');
console.log('  ', authUrl, '\n');

// Try to open browser
const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
execAsync(`${openCmd} "${authUrl}"`).catch(() => {});

// Local callback server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8085');
  if (url.pathname !== '/callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400);
    res.end(`<h1>Erreur : ${error ?? 'code manquant'}</h1>`);
    server.close();
    return;
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const tokens = await tokenRes.json();

  if (!tokenRes.ok) {
    res.writeHead(500);
    res.end(`<h1>Erreur token : ${JSON.stringify(tokens)}</h1>`);
    server.close();
    return;
  }

  res.end('<h1>✅ Authentification réussie — vous pouvez fermer cet onglet.</h1>');
  server.close();

  console.log('\n✅  Tokens obtenus !\n');
  console.log('─'.repeat(60));
  console.log('Exécutez ces commandes dans le répertoire moltbot/ :\n');
  console.log(`  npx wrangler secret put GMAIL_CLIENT_ID`);
  console.log(`  # Valeur : ${CLIENT_ID}\n`);
  console.log(`  npx wrangler secret put GMAIL_CLIENT_SECRET`);
  console.log(`  # Valeur : ${CLIENT_SECRET}\n`);
  console.log(`  npx wrangler secret put GMAIL_REFRESH_TOKEN`);
  console.log(`  # Valeur : ${tokens.refresh_token}\n`);
  console.log('─'.repeat(60));

  if (!tokens.refresh_token) {
    console.warn('\n⚠️  Pas de refresh_token dans la réponse.');
    console.warn('   Révoquez l\'accès de l\'app dans votre compte Google puis relancez ce script.');
  }
});

server.listen(8085, () => {
  console.log('⏳  En attente du callback OAuth sur http://localhost:8085/callback ...');
});
