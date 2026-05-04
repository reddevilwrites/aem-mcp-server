/**
 * Global test setup — runs before every test file.
 *
 * For UNIT tests: ensures minimal env vars are set so config.ts
 *   does not error (it only uses optional() so defaults are fine).
 *
 * For INTEGRATION tests: if .env.test exists in the project root,
 *   dotenv will have already loaded it via the dotenv/config import
 *   in config.ts. Override env vars here only if you need to force
 *   specific values during testing.
 */

// Provide defaults so config.ts never throws during unit tests
process.env['AEM_HOST']     ??= 'http://localhost:4502';
process.env['AEM_USERNAME'] ??= 'admin';
process.env['AEM_PASSWORD'] ??= 'admin';
process.env['AEM_PLATFORM'] ??= 'aemaacs';
