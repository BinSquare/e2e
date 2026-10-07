/**
 * `@e2e-dev/smol` public surface: `smol()`, a browser provider that runs
 * Chromium in smol machines microVMs for `@e2e-dev/web`, branching a warm
 * browser for every test attempt.
 */

export { smol } from './provider.ts';
export type { SmolOptions } from './provider.ts';
