// Local-only check that the sandbox REST app can reach the Disputes API (GET /v1/customer/disputes). Read-only: it
// lists nothing and creates nothing. Prints only the HTTP status and, on error, PayPal's error name and message.
//   npm run paypal:disputes-check
import { assertSandboxHost, loadPayPalConfig } from '@/src/server/payments/paypal';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The disputes check is for local development only.');
  const config = loadPayPalConfig();
  const tokenUrl = `${config.apiBase}/v1/oauth2/token`;
  const disputesUrl = `${config.apiBase}/v1/customer/disputes?page_size=1`;
  assertSandboxHost(tokenUrl);
  assertSandboxHost(disputesUrl);

  const auth = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const token = (await auth.json().catch(() => null) as { access_token?: string } | null)?.access_token;
  if (!auth.ok || !token) {
    console.log(`oauth status=${auth.status}`);
    process.exitCode = 1;
    return;
  }

  const res = await fetch(disputesUrl, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  console.log(`disputes status=${res.status}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { name?: string; error?: string; message?: string; error_description?: string } | null;
    console.log(`error name=${body?.name ?? body?.error ?? 'unknown'} message=${body?.message ?? body?.error_description ?? 'none'}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  // Never print config, tokens or raw responses.
  console.error(error instanceof Error ? error.message : 'Disputes check failed.');
  process.exitCode = 1;
});
