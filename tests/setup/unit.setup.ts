/**
 * Unit-test environment.
 *
 * Unit tests must not touch Postgres or Redis, but importing `src/config/env`
 * transitively (via the error classes, for instance) still triggers schema
 * validation. These placeholders satisfy it without implying a live service.
 */
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??= 'postgresql://unit:unit@127.0.0.1:5432/unit?schema=public';
process.env['REDIS_URL'] ??= 'redis://127.0.0.1:6379';
process.env['JWT_ACCESS_SECRET'] ??= 'unit-test-access-secret-value-of-sufficient-length';
process.env['JWT_REFRESH_SECRET'] ??= 'unit-test-refresh-secret-value-of-sufficient-length';
process.env['LOG_LEVEL'] = 'silent';
process.env['LOG_PRETTY'] = 'false';
process.env['METRICS_ENABLED'] = 'false';
// Keep bcrypt cheap in unit tests; cost factor is exercised in integration.
process.env['BCRYPT_ROUNDS'] = '4';
