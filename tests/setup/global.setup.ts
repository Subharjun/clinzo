import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * One-time preparation for the integration suite.
 *
 * Creates the `clinzo_test` database if absent and applies migrations with
 * `migrate deploy` — the same command production uses, so the schema under
 * test is byte-identical to the deployed one, constraints included. Those
 * constraints are the subject of the concurrency tests, so generating the
 * schema any other way would invalidate the whole exercise.
 */

const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://clinzo:clinzo@localhost:5432/clinzo_test?schema=public&connection_limit=30&pool_timeout=20';

export default async function globalSetup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const databaseName = url.pathname.slice(1);

  // Connect to the maintenance database; CREATE DATABASE cannot run from
  // inside the database being created.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);

    if (existing.rowCount === 0) {
      // Identifier cannot be parameterised; the name comes from our own config.
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
