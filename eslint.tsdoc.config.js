// Dedicated TSDoc syntax gate for sandbox declaration/source files.
//
// Scope: `src/lib/sandbox/**/*.d.ts` + `**/*.ts` (dual-mode: zero `.ts` today;
// converted modules land as `.ts` in Wave 1, carrying the contract tags). The
// full `eslint.config.js` layers core/TS rules on top of `tsdoc/syntax`; this
// config isolates the documentation gate so it can run (and be wired into
// `tests/unit/contracts_gate_test.js`) without inheriting unrelated lint debt.
//
// Only `tsdoc/syntax` is enabled here: contracts must parse as valid TSDoc.

import tseslint from 'typescript-eslint';
import tsdoc from 'eslint-plugin-tsdoc';

/** Contract declarations (today) + converted `.ts` sources (forward mode). */
const TSDOC_FILES = ['src/lib/sandbox/**/*.d.ts', 'src/lib/sandbox/**/*.ts'];

export default [
  {
    name: 'sandbox-tsdoc/ignores',
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**']
  },
  {
    name: 'sandbox-tsdoc/syntax',
    files: TSDOC_FILES,
    // This config loads only `tsdoc/syntax`, so inline directives targeting
    // core/TS rules (used by the full `eslint.config.js`) are reported as
    // unused. Suppress that warning class here; directive hygiene is enforced
    // by the full sandbox lint run instead.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'error'
    }
  }
];
