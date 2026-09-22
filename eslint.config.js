// ESLint 10 flat config — Wave 1 sandbox foundation (hybrid verification path).
//
// Scope: src/lib/sandbox/**/*.js + **/*.ts + **/*.d.ts only. The app/UI layer
// is intentionally not linted yet (later wave). `*.ts` is dual-mode: zero `.ts`
// today; converted modules land as `.ts` in Wave 1 (same parser/rules).
//
// Layers:
//   1. @eslint/js `recommended` — core correctness rules.
//   2. typescript-eslint `recommended` (non-typed) — no
//      `parserOptions.projectService` in this wave.
//   3. `tsdoc/syntax` on `.d.ts` + `.ts` files only: the `.js` layer uses
//      plain JSDoc (`@param {Type} name`), which TSDoc cannot parse and would
//      report as errors; declarations/sources follow TSDoc (`@param name - ...`).
//   4. R2 approximation (selector + limitations below).
//
// Browser + Node globals are both supplied because the sandbox mixes runtime
// APIs; Svelte runes are declared for `sandboxStore.svelte.js`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsdoc from 'eslint-plugin-tsdoc';
import globals from 'globals';

/** Files this config currently governs (dual-mode: `.ts` may be absent today). */
const SANDBOX_FILES = ['src/lib/sandbox/**/*.js', 'src/lib/sandbox/**/*.ts', 'src/lib/sandbox/**/*.d.ts'];

/** Contract declarations (today) + converted `.ts` sources (forward mode). */
const TSDOC_FILES = ['src/lib/sandbox/**/*.d.ts', 'src/lib/sandbox/**/*.ts'];

/** Svelte 5 rune globals (sandboxStore.svelte.js). */
const SVELTE_RUNES = {
  $state: 'readonly',
  $derived: 'readonly',
  $effect: 'readonly',
  $props: 'readonly',
  $bindable: 'readonly',
  $inspect: 'readonly',
  $host: 'readonly'
};

// ---------------------------------------------------------------------------
// R2: cross-module underscore access (`recv._name`).
//
// Verifier rule (scripts/verify_sandbox_contracts.js, §P2.7): flags reads of
// underscore-prefixed members on a receiver that *resolves* to a known foreign
// sandbox module instance; `this._name` is allowed (allowAfterThis).
//
// ESLint without typed linting cannot resolve receivers, so the selector below
// is a syntax-only over-approximation:
//   - `this._x` and `super._x` are excluded;
//   - declarations are never MemberExpression, so they cannot match;
//   - computed access (`recv['_x']`) is NOT matched — the verifier also only
//     inspects TS PropertyAccessExpression, so parity holds there;
//   - known false-positive classes vs. the verifier: underscore members on
//     plain data objects, `process.env._FOO`, third-party instances, and any
//     receiver the verifier cannot resolve but that is not a module instance.
// The verifier baseline reports R2 = 0, so any hit here must be triaged as a
// false positive to tune or a genuine new risk — never silenced blindly.
// ---------------------------------------------------------------------------
const R2_SELECTOR =
  "MemberExpression[object.type!='ThisExpression'][object.type!='Super'][property.name=/^_/]";

export default [
  {
    name: 'sandbox/ignores',
    ignores: ['dist/**', 'node_modules/**', 'playwright-report/**']
  },
  {
    name: 'sandbox/language-options',
    files: SANDBOX_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...SVELTE_RUNES
      }
    }
  },
  {
    name: 'sandbox/js-recommended',
    files: SANDBOX_FILES,
    rules: js.configs.recommended.rules
  },
  ...tseslint.configs.recommended.map(config =>
    config.files ? config : { ...config, files: SANDBOX_FILES }
  ),
  {
    name: 'sandbox/tsdoc-syntax',
    files: TSDOC_FILES,
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'error'
    }
  },
  {
    name: 'sandbox/r2-foreign-underscore',
    files: SANDBOX_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: R2_SELECTOR,
          message:
            'R2: cross-module access to underscore-prefixed member (recv._name) is forbidden; use the declared contract surface.'
        }
      ]
    }
  },
  {
    name: 'sandbox/policy-overrides',
    files: SANDBOX_FILES,
    rules: {
      // Underscore-prefixed bindings are intentional (signature-compatibility
      // parameters / pinned imports): configure the TS rule so directives are
      // not needed and `lint:docs` (which does not load this plugin) is clean.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Contract-visible named options interfaces (`interface X extends Y {}`)
      // must stay interfaces; the emitted declaration shape is pinned by the
      // generated API report, so allow empty interfaces rather than aliases.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      // Policy conflict (intentional): `preserve-caught-error` is ON in
      // @eslint/js `recommended` and would require every `throw new X(...)`
      // inside a catch to attach `{ cause: caught }`. The sandbox's error
      // classes are contract-visible — their serialized/asserted shape is part
      // of module boundaries and the verifier/repro suites — so attaching
      // `cause` would change public error shapes for no functional gain. We
      // deliberately preserve the original error shape and keep the caught
      // error unbound (or logged) instead; this rule is OFF for sandbox files.
      'preserve-caught-error': 'off'
    }
  },
  {
    name: 'sandbox/prem-sdk-any-boundary',
    files: ['src/lib/sandbox/inference/PremProvider/index.ts'],
    rules: {
      // Sanctioned SDK boundary pin (@decision ref 8c3f8cf): the npm
      // `@premai/api-sdk/browser` SDK has no usable type surface, so the
      // enclave client is deliberately typed `any` at this adapter boundary.
      // Scoped OFF here only — the rule stays an error everywhere else.
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
