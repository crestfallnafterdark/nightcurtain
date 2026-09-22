/**
 * @file .dependency-cruiser.cjs
 * @description Architecture gates for the encapsulated sandbox (`src/lib/sandbox/`).
 *
 * Dependency-graph truth: dependency-cruiser builds a *resolved* import graph,
 * unlike the AST specifier checks in scripts/verify_sandbox_contracts.js.
 *
 * Rules:
 *   - sandbox-no-outside-imports .......... sandbox -> outside edges (no exceptions)
 *   - outside-sandbox-entry-only .......... outside callers may only use public roots
 *                                           (mirrors verifier Checks 1-4)
 *   - sandbox-no-deep-imports-<module> .... outside a module folder only the module's
 *                                           index is importable (generated; see below)
 *   - sandbox-no-circular ................. cycles inside the sandbox (baseline clean -> error)
 *   - sandbox-no-orphans .................. disconnected sandbox modules (warn, see comment)
 *
 * Module-surface mode
 * -------------------
 * A module is a directory containing an `index.ts` (or `index.svelte.ts` for the
 * runes store), and only that surface may be imported from outside the module
 * folder. The deep-import rules are generated at config-load time by walking
 * `src/lib/sandbox` for such directories: a rule exists only for folders that
 * actually carry an index; nested module folders are excluded from the parent
 * rule because they are independent modules with their own rule.
 *
 * `enhancedResolveOptions.extensions` lists `.ts` and `.svelte.ts` so
 * `<module>/index.ts` and `sandboxStore/index.svelte.ts` specifiers resolve
 * (explicit extensions are the policy; the suffix entries also cover directory
 * imports).
 *
 * Coverage note: the `gate:arch` script cruises `src/lib/sandbox`, so
 * `outside-sandbox-entry-only` only sees non-sandbox modules that are reachable
 * from the sandbox graph. A full-app cruise (`depcruise src --config
 * .dependency-cruiser.cjs`) performs the complete outside-in scan; verifier
 * Checks 1-4 remain authoritative for `$lib/...` specifiers, because Vite's
 * `$lib` alias cannot be declared here (dependency-cruiser v18's
 * `enhancedResolveOptions` schema does not accept `alias` and there is no
 * webpack/tsconfig path mapping to point at).
 *
 * @see scripts/verify_sandbox_contracts.js (Checks 1-4 at verifyBoundaryIsolation)
 * @see docs/modules/README.md (module-surface conventions)
 * @see AGENTS.md section 3 "Encapsulation boundaries"
 */

const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_PATH = '^src/lib/sandbox/';
const SANDBOX_DIR = path.join(__dirname, 'src', 'lib', 'sandbox');
/** Index file names that make a directory a module (see STRUCTURE.md). */
const MODULE_INDEX_FILES = ['index.ts', 'index.svelte.ts'];

/**
 * Converts an OS path to posix form (dependency-cruiser matches posix paths).
 *
 * @param {string} value Path to normalize.
 * @returns {string} Posix-normalized path.
 */
function toPosix(value) {
  return value.split(path.sep).join('/');
}

/**
 * Escapes regex metacharacters so a literal path can be embedded in a rule.
 *
 * @param {string} value Literal text.
 * @returns {string} Escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds module folders (directories containing `index.ts` or `index.svelte.ts`)
 * under the given directory, recursively. Returned paths are relative to the
 * config file (repo root) in posix form.
 *
 * @param {string} directory Absolute directory to walk.
 * @returns {string[]} Module folder paths, sorted for deterministic rules.
 */
function findModuleFolders(directory) {
  if (!fs.existsSync(directory)) return [];
  const folders = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const absolute = path.join(directory, entry.name);
    const hasIndex = MODULE_INDEX_FILES.some((indexFile) => fs.existsSync(path.join(absolute, indexFile)));
    if (hasIndex) folders.push(toPosix(path.relative(__dirname, absolute)));
    folders.push(...findModuleFolders(absolute));
  }
  return folders.sort();
}

const MODULE_FOLDERS = findModuleFolders(SANDBOX_DIR);

/**
 * One deep-import rule per module folder. Importers inside the module folder
 * may reach internals; importers outside it may only reach the module's index.
 * Nested module folders are excluded from the parent rule because they are
 * independent modules governed by their own rule (avoids double reporting).
 */
const DEEP_IMPORT_RULES = MODULE_FOLDERS.map((folder) => {
  const prefix = escapeRegExp(folder);
  const nested = MODULE_FOLDERS.filter((candidate) => candidate.startsWith(`${folder}/`));
  return {
    name: `sandbox-no-deep-imports-${folder.replace(/[^a-zA-Z0-9]+/g, '-')}`,
    comment: [
      `Outside ${folder}/ only ${folder}/index.ts (or index.svelte.ts) is importable.`,
      'Deep imports bypass the module surface (AGENTS.md §3).',
      nested.length > 0 ? 'Nested module folders are covered by their own rules.' : ''
    ]
      .filter(Boolean)
      .join(' '),
    severity: 'error',
    from: { pathNot: `^${prefix}/` },
    to: {
      path: `^${prefix}/`,
      pathNot: [`^${prefix}/index\\.(?:svelte\\.)?ts$`, ...nested.map((nestedFolder) => `^${escapeRegExp(nestedFolder)}/`)]
    }
  };
});

/**
 * Known sandbox -> outside edges. Historically entries here were tracked in
 * docs/TODO.md and the encapsulation defect register and were the ONLY allowed
 * out-of-sandbox imports. All three have been retired, so the list is now
 * empty; it is kept because the rule builders below spread it to derive:
 *   1. a pathNot exclusion on `sandbox-no-outside-imports` (so the broad rule
 *      does not double-report a future tracked edge),
 *   2. a pair-precise error rule that still forbids the same target for every
 *      OTHER sandbox importer,
 *   3. a warn-level tracked-edge rule that would keep the exception visible in
 *      gate output until it is retired.
 * Re-adding an entry reinstates all three automatically.
 *
 * The array is also exported as `config.TRACKED_SANDBOX_EXCEPTIONS`, the
 * authoritative expected set consumed by scripts/verify_module_contracts.js
 * (an empty array is a valid state: it expects zero generated rules and zero
 * out-of-sandbox @mayImport tags). The export must stay non-enumerable:
 * dependency-cruiser validates this file against a schema with
 * `additionalProperties: false` and rejects unknown enumerable top-level keys,
 * while `require()` still exposes non-enumerable properties.
 */
const TRACKED_SANDBOX_EXCEPTIONS = [];

/**
 * Dependency types that are not sandbox boundary crossings: npm packages,
 * Node core builtins, and bare specifiers the resolver could not map to a
 * project path. The bespoke verifier likewise ignores non-relative specifiers.
 */
const EXTERNAL_DEPENDENCY_TYPES = [
  'npm',
  'npm-dev',
  'npm-optional',
  'npm-peer',
  'npm-bundled',
  'npm-no-pkg',
  'npm-unknown',
  'core',
  'deprecated',
  'undetermined',
  'unknown'
];

/** Public sandbox roots per verifier Checks 1-4. */
const PUBLIC_RUNTIME_ENTRY = '^src/lib/sandbox/runtime/(?!index\\.(?:js|ts|d\\.ts)$)';
const PUBLIC_INFERENCE_ENTRY = '^src/lib/sandbox/inference/(?!index\\.(?:js|ts|d\\.ts)$)';

const FORBIDDEN_SANDBOX_INTERNALS = [
  '^src/lib/sandbox/tools/descriptors/(?!index\\.(?:js|ts|d\\.ts)$)',
  '^src/lib/sandbox/tools/normalizers/(?!index\\.(?:js|ts|d\\.ts)$)',
  PUBLIC_RUNTIME_ENTRY,
  PUBLIC_INFERENCE_ENTRY
];

const config = {
  forbidden: [
    {
      name: 'sandbox-no-outside-imports',
      comment: [
        'Sandbox modules must stay inside src/lib/sandbox/ (outside -> sandbox only).',
        'No tracked exceptions at present (TRACKED_SANDBOX_EXCEPTIONS is empty);',
        'the map below lists any future tracked edges.',
        ...TRACKED_SANDBOX_EXCEPTIONS.map(
          (exception, index) => `(${index + 1}) ${exception.from} -> ${exception.to} [${exception.tracker}].`
        )
      ].join(' '),
      severity: 'error',
      from: { path: SANDBOX_PATH },
      to: {
        pathNot: [SANDBOX_PATH, '^node_modules/', ...TRACKED_SANDBOX_EXCEPTIONS.map((exception) => exception.to)],
        dependencyTypesNot: EXTERNAL_DEPENDENCY_TYPES
      }
    },
    // Pair-precise guards: each tracked target file stays off-limits for every
    // sandbox importer except the one documented in TRACKED_SANDBOX_EXCEPTIONS.
    // With the list empty this expands to nothing; the broad rule above covers
    // every sandbox -> outside edge as an error.
    ...TRACKED_SANDBOX_EXCEPTIONS.map((exception) => ({
      name: `sandbox-no-outside-imports-${exception.slug}`,
      comment: `Only ${exception.from} may import ${exception.to} [${exception.tracker}].`,
      severity: 'error',
      from: { path: SANDBOX_PATH, pathNot: exception.from },
      to: { path: exception.to }
    })),
    // Documentation only: keeps any tracked allowed edge visible in gate output.
    // With the list empty this expands to nothing, so the gate stays 0 errors /
    // 0 warnings until a new exception is tracked.
    ...TRACKED_SANDBOX_EXCEPTIONS.map((exception) => ({
      name: `sandbox-outside-import-tracked-${exception.slug}`,
      comment: `Tracked sandbox -> outside edge: ${exception.from} -> ${exception.to} [${exception.tracker}].`,
      severity: 'warn',
      from: { path: exception.from },
      to: { path: exception.to }
    })),
    {
      name: 'outside-sandbox-entry-only',
      comment: [
        'Non-sandbox modules may only import public sandbox roots (the top-level',
        '.js/.d.ts pairs plus runtime/index and inference/index). Mirrors',
        'scripts/verify_sandbox_contracts.js Checks 1-4: private tool descriptors,',
        'private tool normalizers, private runtime submodules, private inference',
        'submodules.'
      ].join(' '),
      severity: 'error',
      from: { pathNot: SANDBOX_PATH },
      to: { path: FORBIDDEN_SANDBOX_INTERNALS }
    },
    ...DEEP_IMPORT_RULES,
    {
      name: 'sandbox-no-circular',
      comment: [
        'Circular dependencies inside src/lib/sandbox/. Wave 0 baseline was 0',
        'cycles/0 cyclic edges, so this is enforced as an error. Prefer dependency',
        'inversion or a narrow port over a cycle.'
      ].join(' '),
      severity: 'error',
      from: { path: SANDBOX_PATH },
      to: { circular: true }
    },
    {
      name: 'sandbox-no-orphans',
      comment: [
        'Sandbox modules with no dependencies AND no dependents (dependency-cruiser',
        'orphan semantics). Kept at warn: the current baseline is 24 .d.ts contract',
        'files, which are structurally never imported (JS import specifiers resolve',
        'to the sibling .js, never to the .d.ts) and are therefore expected noise.',
        'Real .js orphans must be triaged manually before promoting this rule.'
      ].join(' '),
      severity: 'warn',
      from: { orphan: true, path: SANDBOX_PATH },
      to: {}
    }
  ],
  options: {
    doNotFollow: {
      path: 'node_modules'
    },
    exclude: {
      path: '(^|/)(test-results|docs|\\.playwright|dist|\\.git)(/|$)'
    },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.svelte', '.svelte.ts']
    }
  }
};

// Exposed for scripts/verify_module_contracts.js. Non-enumerable by design:
// dependency-cruiser's config schema forbids additional enumerable top-level
// keys, but `require()` still hands the property to the verifier.
Object.defineProperty(config, 'TRACKED_SANDBOX_EXCEPTIONS', {
  value: TRACKED_SANDBOX_EXCEPTIONS,
  enumerable: false
});

module.exports = config;
