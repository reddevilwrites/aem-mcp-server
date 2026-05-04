/**
 * Shared helpers for integration tests against a local AEMaaCS SDK instance.
 *
 * Connectivity check:
 *   Probes AEM_HOST before any test runs. All integration tests call
 *   skipIfUnavailable() in their beforeAll hook — if AEM is down the test
 *   body is skipped rather than failing, so CI doesn't break when the
 *   local SDK is not running.
 *
 * Default assumptions (overridable via .env.test):
 *   AEM_HOST     = http://localhost:4502
 *   AEM_USERNAME = admin
 *   AEM_PASSWORD = admin
 *   TEST_CONTENT_ROOT = /content          (a path that always exists on any AEM instance)
 *   TEST_DAM_ROOT     = /content/dam
 */

import { AemError } from '../../src/aem-client.js';

export const AEM_HOST     = (process.env['AEM_HOST']     ?? 'http://localhost:4502').replace(/\/$/, '');
export const AEM_USERNAME = process.env['AEM_USERNAME']  ?? 'admin';
export const AEM_PASSWORD = process.env['AEM_PASSWORD']  ?? 'admin';

/** Root path used in query tests — always exists on any AEM instance. */
export const TEST_CONTENT_ROOT = process.env['TEST_CONTENT_ROOT'] ?? '/content';
export const TEST_DAM_ROOT     = process.env['TEST_DAM_ROOT']     ?? '/content/dam';

/**
 * Probe AEM for reachability.
 * Accepts any HTTP response (even 401/403) as "AEM is up" —
 * a network error means AEM is not running.
 *
 * Uses a 5-second timeout so tests don't hang when the SDK hasn't started.
 */
export async function checkAemConnectivity(): Promise<boolean> {
  const url = `${AEM_HOST}/libs/granite/core/content/login.html`;
  const authHeader = `Basic ${Buffer.from(`${AEM_USERNAME}:${AEM_PASSWORD}`).toString('base64')}`;

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5_000),
    });
    // Any HTTP response means AEM is up (even 404 or 403)
    return response.status < 600;
  } catch {
    return false;
  }
}

/**
 * Returns a beforeAll-compatible function that sets the shared
 * availability flag. Use like:
 *
 *   const aem = makeAemContext();
 *   beforeAll(aem.probe);
 *   it('test', async () => {
 *     if (aem.skip()) return;
 *     ...
 *   });
 */
export function makeAemContext() {
  let available = false;

  return {
    probe: async () => {
      available = await checkAemConnectivity();
      if (!available) {
        console.warn(
          `\n  ⚠  AEM not reachable at ${AEM_HOST}` +
          `\n     Skipping integration tests. Start the local AEMaaCS SDK to run them.\n`,
        );
      }
    },
    /** Call at the start of each test body. Returns true when the test should be skipped. */
    skip: () => !available,
  };
}

/**
 * Assert that an index warning string matches the given pattern and
 * optionally verify it does NOT contain certain strings.
 */
export function expectWarning(
  warning: string | undefined,
  contains: RegExp | string,
  notContains?: RegExp | string,
): void {
  if (warning === undefined) {
    throw new Error(`Expected an indexWarning but got undefined`);
  }
  const pattern = typeof contains === 'string' ? new RegExp(contains, 'i') : contains;
  if (!pattern.test(warning)) {
    throw new Error(`indexWarning did not match /${pattern.source}/:\n  ${warning}`);
  }
  if (notContains !== undefined) {
    const negPattern = typeof notContains === 'string'
      ? new RegExp(notContains, 'i')
      : notContains;
    if (negPattern.test(warning)) {
      throw new Error(
        `indexWarning unexpectedly matched /${negPattern.source}/:\n  ${warning}`,
      );
    }
  }
}

/** Re-export AemError for integration tests that need to catch it. */
export { AemError };
