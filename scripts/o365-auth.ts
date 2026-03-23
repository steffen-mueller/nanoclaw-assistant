/**
 * One-time OAuth device code flow to obtain an Office 365 refresh token.
 * Run with: npx tsx scripts/o365-auth.ts
 * Appends OFFICE365_REFRESH_TOKEN to .env on success.
 */
import fs from 'fs';
import path from 'path';

import {
  PublicClientApplication,
  DeviceCodeRequest,
} from '@azure/msal-node';

function readEnv(): Record<string, string> {
  const envPath = path.join(process.cwd(), '.env');
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return result;
}

async function main(): Promise<void> {
  const env = readEnv();
  const clientId = process.env.OFFICE365_CLIENT_ID || env.OFFICE365_CLIENT_ID;
  const tenantId = process.env.OFFICE365_TENANT_ID || env.OFFICE365_TENANT_ID;
  const clientSecret =
    process.env.OFFICE365_CLIENT_SECRET || env.OFFICE365_CLIENT_SECRET;

  if (!clientId || !tenantId || !clientSecret) {
    console.error(
      'Missing OFFICE365_CLIENT_ID, OFFICE365_TENANT_ID, or OFFICE365_CLIENT_SECRET in .env',
    );
    process.exit(1);
  }

  console.log('\n=== Office 365 Authentication ===\n');

  // Device code flow uses PublicClientApplication.
  // The refresh token it yields is then used by our msgraph.ts with client credentials.
  // Enable "Allow public client flows" in the Azure portal for this app.
  const msalApp = new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });

  const scopes = [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Mail.ReadWrite.Shared',
    'https://graph.microsoft.com/Mail.Read.Shared',
    'https://graph.microsoft.com/Calendars.Read',
    'https://graph.microsoft.com/Calendars.ReadWrite',
    'offline_access',
  ];

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes,
    deviceCodeCallback: (response) => {
      console.log(response.message);
      console.log('\nWaiting for authentication...\n');
    },
  };

  try {
    const result = await msalApp.acquireTokenByDeviceCode(deviceCodeRequest);

    if (!result?.account) {
      console.error('Authentication failed: no account returned');
      process.exit(1);
    }

    // Retrieve refresh token from MSAL's token cache
    const tokenCache = msalApp.getTokenCache();
    const cacheData = JSON.parse(await tokenCache.serialize()) as {
      RefreshToken?: Record<string, { secret: string }>;
    };
    const refreshTokenEntry = Object.values(
      cacheData.RefreshToken || {},
    )[0];

    if (!refreshTokenEntry?.secret) {
      console.error(
        'Could not extract refresh token from MSAL cache.\n' +
          'Make sure offline_access scope is included.',
      );
      process.exit(1);
    }

    const refreshToken = refreshTokenEntry.secret;
    console.log('\n✓ Authenticated successfully!\n');

    // Append to .env
    const envPath = path.join(process.cwd(), '.env');
    let envContent = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, 'utf-8')
      : '';
    envContent = envContent
      .split('\n')
      .filter((l) => !l.startsWith('OFFICE365_REFRESH_TOKEN='))
      .join('\n');
    if (!envContent.endsWith('\n')) envContent += '\n';
    envContent += `OFFICE365_REFRESH_TOKEN=${refreshToken}\n`;
    fs.writeFileSync(envPath, envContent);

    console.log('OFFICE365_REFRESH_TOKEN saved to .env');
    console.log('\nNext steps:');
    console.log('  cp .env data/env/env');
    console.log('  systemctl --user restart nanoclaw\n');
  } catch (err) {
    console.error('Authentication error:', err);
    process.exit(1);
  }
}

main();
