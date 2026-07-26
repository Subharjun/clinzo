/**
 * Integration-test environment.
 *
 * These tests run against real Postgres and real Redis — the concurrency
 * guarantees under test are properties of those systems, and a mock would
 * prove nothing about them.
 *
 * A dedicated `clinzo_test` database keeps the suite from destroying local
 * development data; `global.setup.ts` creates and migrates it.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://clinzo:clinzo@localhost:5432/clinzo_test?schema=public&connection_limit=30&pool_timeout=20';
process.env['REDIS_URL'] = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379/1';

process.env['JWT_ACCESS_SECRET'] ??= 'integration-test-access-secret-of-sufficient-length';
process.env['JWT_REFRESH_SECRET'] ??= 'integration-test-refresh-secret-of-sufficient-length';

process.env['LOG_LEVEL'] = 'silent';
process.env['LOG_PRETTY'] = 'false';
process.env['METRICS_ENABLED'] = 'false';

// Cheapest valid bcrypt cost. Fixture users are created by the dozen and the
// suite is not testing bcrypt's work factor.
process.env['BCRYPT_ROUNDS'] = '4';

// The configured floor. Hold-expiry tests do not wait this out — they backdate
// `expiresAt` and drive the sweeper directly, which is the same code path a
// lapsed hold takes in production and takes milliseconds instead of seconds.
process.env['RESERVATION_HOLD_TTL_SECONDS'] = '10';

// Generous lock timeout: the 100-way concurrency test intentionally creates
// contention, and every contender must get its turn rather than time out.
process.env['LOCK_ACQUIRE_TIMEOUT_MS'] = '15000';
process.env['LOCK_TTL_MS'] = '5000';

// Caching would mask the state transitions these tests assert on.
process.env['SLOT_CACHE_TTL_SECONDS'] = '0';

// Rate limiting is exercised by its own test with an explicit override.
process.env['RATE_LIMIT_MAX'] = '100000';
process.env['AUTH_RATE_LIMIT_MAX'] = '100000';
process.env['BOOKING_RATE_LIMIT_MAX'] = '100000';
