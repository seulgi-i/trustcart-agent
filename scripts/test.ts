// Runs the test suite against a throwaway SQLite database built from the committed migrations.
import { execSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

// SQLite paths in DATABASE_URL resolve relative to prisma/schema.prisma, so this is prisma/test.db (never the dev DB).
const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: 'file:./test.db', NODE_ENV: 'test' } as NodeJS.ProcessEnv;
for (const file of ['prisma/test.db', 'prisma/test.db-journal']) rmSync(file, { force: true });
execSync('npx prisma migrate deploy', { stdio: 'inherit', env });
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/*.test.ts'], { stdio: 'inherit', env });
process.exitCode = result.status ?? 1;
