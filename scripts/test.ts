// Unit tests always run. DB integration tests (tests/*.db.test.ts) run only when TEST_DATABASE_URL points at a
// throwaway Postgres database; the committed migrations are applied to it first.
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const testDb = process.env.TEST_DATABASE_URL?.trim();
// Never the dev/prod DB: without TEST_DATABASE_URL, Prisma gets an unreachable URL so a stray query fails fast.
const dbUrl = testDb || 'postgresql://unused:unused@127.0.0.1:1/unused';
// Secrets are blanked (not deleted) so a .env loaded later cannot fill them: tests never reach PayPal or an LLM.
const env: NodeJS.ProcessEnv = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: dbUrl, DIRECT_URL: dbUrl,
  PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '',
  OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: '',
  // Chat always uses the scripted mock model (replay fixtures in tests/fixtures/ai); recording is off.
  AI_PROVIDER: 'mock', AI_RECORD: '', OLLAMA_BASE_URL: '', OLLAMA_MODEL: '',
  DEMO_PASSWORD: '', SESSION_SECRET: '', APP_BASE_URL: '', VERCEL_URL: '',
  // Mandates are signed with the derived development key; tests that need another key pass one explicitly.
  MANDATE_SIGNING_KEY: '',
  RATE_LIMIT_SESSION_PER_HOUR: '', RATE_LIMIT_GLOBAL_PER_DAY: '',
  // Layer-1 limits at their documented defaults, whatever the developer's .env says.
  LAYER1_VELOCITY_MAX: '', LAYER1_VELOCITY_WINDOW_MINUTES: '', LAYER1_SPLIT_SINGLE_LIMIT_CENTS: '', LAYER1_SPLIT_WINDOW_MINUTES: '',
  LAYER1_DUPLICATE_WINDOW_MINUTES: '', LAYER1_DAILY_HARD_CAP_CENTS: '', LAYER1_MONTHLY_HARD_CAP_CENTS: '',
} as NodeJS.ProcessEnv;

const files = readdirSync('tests').filter(f => f.endsWith('.test.ts')).sort();
const selected = files.filter(f => testDb || !f.endsWith('.db.test.ts')).map(f => `tests/${f}`);
if (testDb) execSync('npx prisma migrate deploy', { stdio: 'inherit', env });
else console.log(`TEST_DATABASE_URL not set: skipping DB integration tests (${files.filter(f => f.endsWith('.db.test.ts')).join(', ')}).`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...selected], { stdio: 'inherit', env });
process.exitCode = result.status ?? 1;
