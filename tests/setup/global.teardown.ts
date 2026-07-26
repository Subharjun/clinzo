/**
 * Global teardown for the integration suite.
 *
 * The test database is intentionally left in place: recreating it on every run
 * costs seconds, and having it available afterwards makes a failed
 * concurrency assertion inspectable with psql. Per-test isolation comes from
 * truncation in `tests/helpers/database.ts`, not from dropping the database.
 */
export default async function globalTeardown(): Promise<void> {
  // Nothing to release here — connections are closed per test file. This hook
  // exists so the intent above is recorded rather than assumed.
}
