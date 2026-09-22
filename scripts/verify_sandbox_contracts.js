#!/usr/bin/env node
/**
 * @file scripts/verify_sandbox_contracts.js
 * @description Automated AST-based contract verification engine.
 * Validates the Three-Pillar Full Isolation architecture across all sandbox modules.
 *
 * Mandates:
 * 1. MATHEMATICAL WHITELIST ENFORCEMENT:
 *    - Parses every .d.ts header file in src/lib/sandbox/ to extract declared exports (D).
 *    - Parses every .js implementation file in src/lib/sandbox/ to extract actual exports (E).
 *    - Proves E \ D = ∅ (zero leaked unwhitelisted runtime exports).
 * 2. BOUNDARY ISOLATION ENFORCEMENT:
 *    - Verifies that external callers only import from public module roots,
 *      never from private internal descriptors, normalizers, or private subpaths.
 * 3. AUDIT & REPORT:
 *    - Emits a comprehensive verification report with exact symbol sets and isolation proofs.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SANDBOX_DIR = path.join(PROJECT_ROOT, 'src/lib/sandbox');
const SRC_DIR = path.join(PROJECT_ROOT, 'src');
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');

/** Filenames that mark a directory as a TypeScript-rewrite module surface. */
const SURFACE_FILENAMES = ['index.ts', 'index.svelte.ts'];

const CLI_FLAGS = new Set(process.argv.slice(2));
const ENFORCE_BOUNDARIES = CLI_FLAGS.has('--enforce-boundaries');
const JSON_OUTPUT = CLI_FLAGS.has('--json');
const BOUNDARY_EXAMPLE_LIMIT = 20;

/**
 * Human-report sink. Silenced when --json is requested so stdout stays parseable.
 *
 * @param {...unknown} args
 */
const log = JSON_OUTPUT ? () => {} : (...args) => process.stdout.write(`${args.join(' ')}\n`);

/**
 * Resolves a module specifier relative to the importing file.
 *
 * @param {string} currentFile
 * @param {string} specifier
 * @param {boolean} isDts
 * @param {boolean} allowTsSource follow TypeScript source rewrites (`.js` -> `.ts`)
 * @returns {string|null}
 */
function resolveModulePath(currentFile, specifier, isDts, allowTsSource = false) {
  let target = path.resolve(path.dirname(currentFile), specifier);
  if (isDts) {
    if (target.endsWith('.js')) target = target.slice(0, -3) + '.d.ts';
    if (target.endsWith('.svelte.js')) target = target.slice(0, -10) + '.svelte.d.ts';
    if (!fs.existsSync(target)) {
      const alt = target.replace(/\.d\.ts$/, '.ts');
      if (fs.existsSync(alt)) target = alt;
    }
  } else if (allowTsSource && !fs.existsSync(target)) {
    const candidates = [];
    if (target.endsWith('.js')) candidates.push(target.slice(0, -3) + '.ts');
    candidates.push(`${target}.ts`, path.join(target, 'index.ts'));
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        target = candidate;
        break;
      }
    }
  }
  return fs.existsSync(target) ? target : null;
}

/**
 * Extracts exported symbols from a TypeScript or JavaScript source file via AST.
 *
 * @param {string} filePath
 * @param {boolean} isDts
 * @param {Set<string>} visited
 * @param {boolean} allowTsSource extracts a `.ts` implementation (P3.1 manifest mode)
 * @returns {Set<string>}
 */
function extractExports(filePath, isDts, visited = new Set(), allowTsSource = false) {
  if (visited.has(filePath)) return new Set();
  visited.add(filePath);

  const exports = new Set();
  if (!fs.existsSync(filePath)) return exports;

  const content = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );

  ts.forEachChild(sourceFile, node => {
    // 1. Modifiers check (export / export default)
    const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);

    if (hasExport) {
      if (isDefault) {
        exports.add('default');
      }
      // `export default class Foo` / `export default function foo` bind a local
      // name only — the sole export is `default`. Historical `.js`/`.d.ts`
      // extraction is preserved; `.ts` implementations follow ECMAScript.
      if (!(isDefault && allowTsSource)) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          exports.add(node.name.text);
        } else if (ts.isClassDeclaration(node) && node.name) {
          exports.add(node.name.text);
        } else if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach(d => {
            if (d.name && ts.isIdentifier(d.name)) {
              exports.add(d.name.text);
            }
          });
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          exports.add(node.name.text);
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          exports.add(node.name.text);
        } else if (ts.isEnumDeclaration(node) && node.name) {
          exports.add(node.name.text);
        }
      }
    }

    // 2. Export declarations: export { a, b as c } or export * from '...'
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause) {
        if (ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach(elem => {
            exports.add(elem.name.text);
          });
        } else if (ts.isNamespaceExport(node.exportClause)) {
          exports.add(node.exportClause.name.text);
        }
      } else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        // Recursive re-export: export * from './module.js'
        const targetPath = resolveModulePath(filePath, node.moduleSpecifier.text, isDts, allowTsSource);
        if (targetPath) {
          const subExports = extractExports(targetPath, isDts, visited, allowTsSource);
          for (const s of subExports) {
            exports.add(s);
          }
        }
      }
    }

    // 3. Export default assignments: export default ...
    if (ts.isExportAssignment(node)) {
      exports.add('default');
    }
  });

  return exports;
}

/**
 * Classifies a sandbox-relative module path into its audit category.
 *
 * @param {string} rel
 * @returns {string}
 */
function categorizeModule(rel) {
  if (rel.startsWith('runtime/')) return 'Runtime Subsystem';
  if (rel.startsWith('inference/')) return 'Inference Subsystem';
  if (rel.startsWith('domain/')) return 'Domain Entity';
  if (rel.startsWith('tools/')) return 'Tools Subsystem';
  return 'Root Sandbox';
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isSurfaceFile(filePath) {
  return SURFACE_FILENAMES.includes(path.basename(filePath));
}

/**
 * Discovers folder-mode modules: directories containing `index.ts` or
 * `index.svelte.ts`. Subdirectories of a module are separate modules; a
 * directory holding only notes (e.g. `CONVERSION.md`) is not a module.
 *
 * @param {string} dir
 * @returns {Array<{ rel: string, moduleDir: string, surfacePath: string, surfaceName: string, category: string }>}
 */
function findFolderModules(dir) {
  const modules = [];

  function scan(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (current !== dir) {
      const surfaceName = SURFACE_FILENAMES.find(name =>
        entries.some(entry => entry.isFile() && entry.name === name)
      );
      if (surfaceName) {
        const rel = path.relative(SANDBOX_DIR, current);
        modules.push({
          rel,
          moduleDir: current,
          surfacePath: path.join(current, surfaceName),
          surfaceName,
          category: categorizeModule(`${rel}/`)
        });
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) scan(path.join(current, entry.name));
    }
  }

  scan(dir);
  return modules.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * @param {string} childPath
 * @param {string} parentDir
 * @returns {boolean}
 */
function isInsideDirectory(childPath, parentDir) {
  return childPath === parentDir || childPath.startsWith(parentDir + path.sep);
}

/**
 * Resolves an import specifier to a file, covering `$lib/` aliasing, directory
 * index files, and TypeScript's `.js` -> `.ts` source rewrite. Returns null for
 * external packages and unresolvable specifiers.
 *
 * @param {string} importer
 * @param {string} specifier
 * @returns {string|null}
 */
function resolveImportTarget(importer, specifier) {
  let base;
  if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(importer), specifier);
  } else if (specifier.startsWith('$lib/')) {
    base = path.resolve(SRC_DIR, 'lib', specifier.slice('$lib/'.length));
  } else {
    return null;
  }

  const queryIndex = base.search(/[?#]/);
  if (queryIndex !== -1) base = base.slice(0, queryIndex);

  const candidates = [base];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  if (!path.extname(base)) candidates.push(`${base}.ts`, `${base}.js`, `${base}.svelte`);
  candidates.push(
    path.join(base, 'index.ts'),
    path.join(base, 'index.svelte.ts'),
    path.join(base, 'index.js')
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Finds the nearest folder-mode module owning a resolved target file.
 *
 * @param {string} targetPath
 * @param {Map<string, object>} moduleByDir
 * @returns {object|null}
 */
function findOwningFolderModule(targetPath, moduleByDir) {
  let current = path.dirname(targetPath);
  while (current === SANDBOX_DIR || current.startsWith(SANDBOX_DIR + path.sep)) {
    const owner = moduleByDir.get(current);
    if (owner) return owner;
    if (current === SANDBOX_DIR) break;
    current = path.dirname(current);
  }
  return null;
}

/**
 * Finds all (.d.ts, .js) contract module pairs in the sandbox directory.
 *
 * @param {string} dir
 * @returns {Array<{ rel: string, dtsPath: string, jsPath: string, category: string }>}
 */
function findContractModulePairs(dir) {
  const pairs = [];

  function scan(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        scan(full);
      } else if (e.name.endsWith('.d.ts')) {
        let jsName = e.name.replace(/\.d\.ts$/, '.js');
        if (e.name.endsWith('.svelte.d.ts')) {
          jsName = e.name.replace(/\.svelte\.d\.ts$/, '.svelte.js');
        }
        const jsPath = path.join(current, jsName);
        if (!fs.existsSync(jsPath)) continue;
        // Folder-mode modules own their surface: the legacy hand-`.d.ts` E/D
        // shadow comparison is skipped once a real `index.ts` exists.
        const tsCandidate = jsName.replace(/\.js$/, '.ts');
        if (isSurfaceFile(tsCandidate) && fs.existsSync(path.join(current, tsCandidate))) continue;
        const rel = path.relative(SANDBOX_DIR, jsPath);
        pairs.push({ rel, dtsPath: full, jsPath, category: categorizeModule(rel) });
      }
    }
  }

  scan(dir);
  return pairs.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * P3.1: finds every `.ts` implementation file in the sandbox tree. Sibling
 * `.d.ts` contracts are excluded — they are never implementations.
 *
 * @param {string} dir
 * @returns {Array<{ rel: string, tsPath: string, category: string }>}
 */
function findTsImplementationFiles(dir) {
  const files = [];

  function scan(current) {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        scan(full);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        const rel = path.relative(SANDBOX_DIR, full);
        files.push({ rel, tsPath: full, category: categorizeModule(rel) });
      }
    }
  }

  scan(dir);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * P3.1: extracts the `@contractExports` manifest from the leading TSDoc block
 * of a `.ts` implementation. The header is everything before the first
 * statement; `default` denotes a default export, re-exports and type-only
 * exports are listed by their exported identifier.
 *
 * @param {string} tsPath
 * @returns {{ present: boolean, symbols: Set<string>, occurrences: number }}
 */
function extractContractExportsManifest(tsPath) {
  const content = fs.readFileSync(tsPath, 'utf-8');
  const sourceFile = ts.createSourceFile(tsPath, content, ts.ScriptTarget.Latest, false);
  const headerEnd =
    sourceFile.statements.length > 0 ? sourceFile.statements[0].getStart(sourceFile) : content.length;
  const header = content.slice(0, headerEnd);

  const symbols = new Set();
  let occurrences = 0;
  const tagPattern = /^(?:[ \t]*\*[ \t]*|[ \t]*\/\*\*[ \t]*)@contractExports\b([^\n\r]*)/gm;
  for (const match of header.matchAll(tagPattern)) {
    occurrences += 1;
    const remainder = match[1].replace(/\*\//g, '');
    for (const token of remainder.split(',')) {
      const symbol = token.trim();
      if (symbol) symbols.add(symbol);
    }
  }

  return { present: occurrences > 0, symbols, occurrences };
}

/**
 * P3.1: audits `.ts` implementations that still carry an `@contractExports`
 * manifest, proving E \ D = ∅ (no untracked export) AND D \ E = ∅ (no stale
 * declaration). The manifest is retired for folder-mode surfaces (their
 * contract is `index.ts` itself) and optional elsewhere, so files without one
 * are skipped rather than failed.
 *
 * @returns {Array<object>}
 */
function auditTsImplementations() {
  const entries = [];

  for (const file of findTsImplementationFiles(SANDBOX_DIR)) {
    if (isSurfaceFile(file.tsPath)) continue;
    const manifest = extractContractExportsManifest(file.tsPath);
    if (!manifest.present) continue;

    const actual = extractExports(file.tsPath, false, new Set(), true);
    const declared = manifest.symbols;

    const leaked = [...actual].filter(symbol => !declared.has(symbol)).sort();
    const stale = [...declared].filter(symbol => !actual.has(symbol)).sort();
    const messages = [];

    if (manifest.occurrences > 1) {
      messages.push(`found ${manifest.occurrences} @contractExports lines; exactly one is allowed`);
    }
    if (declared.size === 0) {
      messages.push('empty @contractExports manifest; list at least one export identifier');
    }
    if (leaked.length > 0) messages.push(`untracked exports (E \\ D): ${leaked.join(', ')}`);
    if (stale.length > 0) messages.push(`stale declarations (D \\ E): ${stale.join(', ')}`);

    entries.push({
      module: file.rel,
      category: file.category,
      declared,
      actual,
      leaked,
      stale,
      messages,
      passed: messages.length === 0
    });
  }

  return entries;
}

/**
 * Prints the P3.1 `.ts` `@contractExports` manifest audit section.
 *
 * @param {Array<object>} entries
 */
function printTsManifestAudit(entries) {
  if (entries.length === 0) return;

  log(`\n${BOLD}TS MANIFEST CONTRACT AUDIT (P3.1 @contractExports):${RESET}`);
  log('----------------------------------------------------------------------------------------------------');
  log(
    `${'STATUS'.padEnd(8)} | ` +
      `${'MODULE'.padEnd(44)} | ` +
      `${'CATEGORY'.padEnd(19)} | ` +
      `${'DECLARED (D)'.padEnd(12)} | ` +
      `${'ACTUAL (E)'.padEnd(10)} | ` +
      `${'LEAKED (E\\D)'.padEnd(12)} | ` +
      `${'STALE (D\\E)'}`
  );
  log('----------------------------------------------------------------------------------------------------');

  for (const entry of entries) {
    const statusStr = entry.passed ? `${GREEN}✔ PASS${RESET}` : `${RED}✖ FAIL${RESET}`;
    const leakedStr =
      entry.leaked.length === 0 ? `${GREEN}0 (∅)${RESET}` : `${RED}${entry.leaked.join(', ')}${RESET}`;
    const staleStr =
      entry.stale.length === 0 ? `${GREEN}0 (∅)${RESET}` : `${RED}${entry.stale.join(', ')}${RESET}`;

    log(
      `${statusStr.padEnd(17)} | ` +
        `${entry.module.padEnd(44)} | ` +
        `${entry.category.padEnd(19)} | ` +
        `${String(entry.declared.size).padStart(11)}  | ` +
        `${String(entry.actual.size).padStart(9)}  | ` +
        `${leakedStr.padEnd(21)} | ` +
        `${staleStr}`
    );
    for (const message of entry.messages) {
      log(`       ${DIM}${entry.module}${RESET}  ${RED}${message}${RESET}`);
    }
  }
  log('----------------------------------------------------------------------------------------------------');
}

/**
 * Flags `.ts` implementations that still carry a hand-written sibling `.d.ts`
 * contract. Folder-mode surfaces have no separate contract file; their types
 * are compiler-emitted or declared in the surface itself.
 *
 * @returns {Array<{ file: string, message: string }>}
 */
function findSiblingContractConflicts() {
  const findings = [];

  for (const file of findTsImplementationFiles(SANDBOX_DIR)) {
    const siblingDts = file.tsPath.replace(/\.ts$/, '.d.ts');
    if (!fs.existsSync(siblingDts)) continue;
    findings.push({
      file: file.rel,
      message: `sibling contract '${path.relative(PROJECT_ROOT, siblingDts)}' is forbidden (.ts implementations must not have a sibling .d.ts)`
    });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Flags leftover flat implementation/contract files beside a folder-mode
 * surface (`index.js` next to `index.ts`), which would make resolution
 * ambiguous.
 *
 * @param {Array<{ rel: string, moduleDir: string, surfaceName: string }>} folderModules
 * @returns {Array<{ module: string, file: string, message: string }>}
 */
function findFolderModuleConflicts(folderModules) {
  const findings = [];

  for (const module of folderModules) {
    const legacyName = module.surfaceName.replace(/\.ts$/, '.js');
    const legacyPath = path.join(module.moduleDir, legacyName);
    if (!fs.existsSync(legacyPath)) continue;
    findings.push({
      module: module.rel,
      file: path.relative(PROJECT_ROOT, legacyPath),
      message: `folder-mode module has a conflicting '${legacyName}' beside '${module.surfaceName}'`
    });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Prints the folder-mode module section and any flat/folder file conflicts.
 *
 * @param {Array<object>} folderModules
 * @param {Array<object>} folderConflicts
 * @param {Array<object>} siblingConflicts
 */
function printFolderModules(folderModules, folderConflicts, siblingConflicts) {
  if (folderModules.length > 0) {
    log(`\n${BOLD}FOLDER-MODE MODULES (contract = <module>/index.ts | index.svelte.ts; legacy E/D shadow skipped):${RESET}`);
    log('----------------------------------------------------------------------------------------------------');
    for (const module of folderModules) {
      const moduleConflicts = folderConflicts.filter(conflict => conflict.module === module.rel);
      const statusStr =
        moduleConflicts.length === 0 ? `${GREEN}✔ PASS${RESET}` : `${RED}✖ FAIL${RESET}`;
      log(
        `${statusStr.padEnd(17)} | ` +
          `${module.rel.padEnd(44)} | ` +
          `${path.relative(PROJECT_ROOT, module.surfacePath)}`
      );
      for (const conflict of moduleConflicts) {
        log(`       ${DIM}${conflict.file}${RESET}  ${RED}${conflict.message}${RESET}`);
      }
    }
    log('----------------------------------------------------------------------------------------------------');
  }

  if (siblingConflicts.length > 0) {
    log(`\n${BOLD}${RED}SIBLING CONTRACT CONFLICTS (.ts with hand-written .d.ts):${RESET}`);
    log('----------------------------------------------------------------------------------------------------');
    for (const conflict of siblingConflicts) {
      log(`  ${RED}✖${RESET} ${conflict.file}  ${conflict.message}`);
    }
    log('----------------------------------------------------------------------------------------------------');
  }
}

/**
 * Scans `src/` (plus `tests/` and `scripts/` for the folder-mode rule) to
 * verify boundary isolation and the deep-import ban. Legacy Checks 1-4 cover
 * flat modules only; once a target lives in a module folder with a real
 * `index.ts`, only that surface is importable from outside the folder (the
 * deep-import rule is dormant while no `index.ts` exists).
 *
 * @returns {{ legacyViolations: Array<object>, deepImportViolations: Array<object> }}
 */
function verifyBoundaryIsolation() {
  const legacyViolations = [];
  const deepImportViolations = [];

  const folderModules = findFolderModules(SANDBOX_DIR);
  const moduleByDir = new Map(folderModules.map(module => [module.moduleDir, module]));

  function scanFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git' && e.name !== 'dist') {
          files.push(...scanFiles(full));
        }
      } else if (
        e.name.endsWith('.js') ||
        e.name.endsWith('.mjs') ||
        e.name.endsWith('.cjs') ||
        e.name.endsWith('.ts') ||
        e.name.endsWith('.svelte')
      ) {
        files.push(full);
      }
    }
    return files;
  }

  const checkSpecifier = (file, specifier, allowLegacyChecks) => {
    if (!specifier || typeof specifier !== 'string') return;

    const resolvedTarget = resolveImportTarget(file, specifier);
    const owner = resolvedTarget ? findOwningFolderModule(resolvedTarget, moduleByDir) : null;

    if (owner && !isInsideDirectory(file, owner.moduleDir) && resolvedTarget !== owner.surfacePath) {
      deepImportViolations.push({
        file: path.relative(PROJECT_ROOT, file),
        imported: specifier,
        violation: `Forbidden deep import into folder module '${owner.rel}': outside the module folder only '${path.relative(SANDBOX_DIR, owner.surfacePath)}' is importable`
      });
    }

    if (!allowLegacyChecks) return;
    if (owner) return; // folder-mode surface rule replaced Checks 1-4 for this target
    if (!specifier.startsWith('.')) return; // external package / $lib alias handled above

    const isInsideSandbox = file.startsWith(SANDBOX_DIR);
    const isInsideTools = file.startsWith(path.join(SANDBOX_DIR, 'tools'));
    const resolved = path.resolve(path.dirname(file), specifier);
    const relToSandbox = path.relative(SANDBOX_DIR, resolved);

    // Check 1: Private tool descriptors (only toolDefinitions.js or tools/ internal may access)
    if (relToSandbox.startsWith('tools/descriptors/') || relToSandbox.startsWith('tools/descriptors')) {
      const allowed = isInsideTools || file === path.join(SANDBOX_DIR, 'toolDefinitions.js');
      if (!allowed) {
        legacyViolations.push({
          file: path.relative(PROJECT_ROOT, file),
          imported: specifier,
          violation: 'Forbidden import of private tool descriptors from external caller'
        });
      }
    }

    // Check 2: Private tool normalizers (only toolDefinitions.js or tools/ internal may access)
    if (relToSandbox.startsWith('tools/normalizers/') || relToSandbox.startsWith('tools/normalizers')) {
      const allowed = isInsideTools || file === path.join(SANDBOX_DIR, 'toolDefinitions.js');
      if (!allowed) {
        legacyViolations.push({
          file: path.relative(PROJECT_ROOT, file),
          imported: specifier,
          violation: 'Forbidden import of private tool normalizers from external caller'
        });
      }
    }

    // Check 3: Private runtime submodules (external callers outside src/lib/sandbox/ must import from runtime/index.js)
    if (relToSandbox.startsWith('runtime/') && !relToSandbox.startsWith('runtime/index')) {
      const allowed = isInsideSandbox;
      if (!allowed) {
        legacyViolations.push({
          file: path.relative(PROJECT_ROOT, file),
          imported: specifier,
          violation: 'Forbidden import of private runtime submodule by non-sandbox caller'
        });
      }
    }

    // Check 4: Private inference submodules (external callers outside src/lib/sandbox/ must import from inference/index.js)
    if (relToSandbox.startsWith('inference/') && !relToSandbox.startsWith('inference/index')) {
      const allowed = isInsideSandbox;
      if (!allowed) {
        legacyViolations.push({
          file: path.relative(PROJECT_ROOT, file),
          imported: specifier,
          violation: 'Forbidden import of private inference submodule by non-sandbox caller'
        });
      }
    }
  };

  const scanFile = (file, allowLegacyChecks) => {
    const sourceFile = parseRuntimeSource(file);
    ts.forEachChild(sourceFile, node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(file, node.moduleSpecifier.text, allowLegacyChecks);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        checkSpecifier(file, node.moduleSpecifier.text, allowLegacyChecks);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          checkSpecifier(file, arg.text, allowLegacyChecks);
        }
      }
    });
  };

  for (const file of scanFiles(SRC_DIR)) scanFile(file, true);
  for (const file of scanFiles(TESTS_DIR)) scanFile(file, false);
  for (const file of scanFiles(SCRIPTS_DIR)) scanFile(file, false);

  return { legacyViolations, deepImportViolations };
}

// ============================================================================
// P2.7 BOUNDARY RULES (opt-in enforcement via --enforce-boundaries)
//
// R1 Class-member parity ....... .d.ts class members vs .js class members
// R2 Cross-module underscore ... `recv._name` where `recv` resolves to a
//                                module instance (excludes `this._name`)
// R3 Dynamic property writes ... `recv.prop = ...` where `prop` is not a
//                                declared class member (excludes `this`)
// R4 Tool schema integrity ..... descriptor schema properties missing `type`
//
// Findings are reported as warnings by default. Passing --enforce-boundaries
// converts any boundary finding into a non-zero exit code.
// ============================================================================

/** Assignment operators tracked by R3 (comparison operators excluded). */
const ASSIGNMENT_OPERATOR_KINDS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

/** Inherited Error members that are expected to be absent from contracts. */
const ERROR_BASE_MEMBER_NAMES = new Set(['name', 'message', 'stack', 'cause']);

/**
 * Conventional variable/field aliases that resolve to a sandbox contract class.
 * These cover constructor-injected back-references whose JSDoc is typed `Object`.
 */
const MODULE_INSTANCE_ALIAS_HINTS = new Map([
  ['AgentRuntime', ['runtime', 'agentRuntime', 'actualRuntime', 'runtimeHost', 'hostRuntime']],
  ['Agent', ['agent', 'agentInstance']],
  ['VirtualFS', ['vfs', 'vFs']],
  ['MessagingBus', ['bus', 'mBus', 'messageBus']],
  ['WorldClock', ['clock']],
  ['RuntimeScheduler', ['scheduler']],
  ['TriggerDispatcher', ['dispatcher']],
  ['RuntimeTelemetry', ['telemetryTracker']],
  ['HistoryManager', ['history']],
  ['AgentLifecycleManager', ['agentLifecycle']],
  ['TurnExecutionEngine', ['turnEngine']]
]);

/**
 * Converts a PascalCase contract class name to its lower-camel variable form.
 *
 * @param {string} name
 * @returns {string}
 */
function toLowerCamel(name) {
  return name.length === 0 ? name : name[0].toLowerCase() + name.slice(1);
}

/**
 * @param {import('typescript').SourceFile} sourceFile
 * @param {import('typescript').Node} node
 * @returns {number} 1-based source line
 */
function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(Math.max(0, node.getStart(sourceFile))).line + 1;
}

/**
 * @param {import('typescript').SourceFile} sourceFile
 * @param {import('typescript').Node} node
 * @returns {string}
 */
function compactSnippet(sourceFile, node) {
  return node.getText(sourceFile).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * @param {import('typescript').Node} node
 * @param {import('typescript').SyntaxKind} kind
 * @returns {boolean}
 */
function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some(mod => mod.kind === kind));
}

/**
 * @param {import('typescript').Node|undefined} nameNode
 * @returns {string|null}
 */
function memberNameText(nameNode) {
  if (!nameNode) return null;
  if (
    ts.isIdentifier(nameNode) ||
    ts.isStringLiteral(nameNode) ||
    ts.isNumericLiteral(nameNode) ||
    ts.isPrivateIdentifier(nameNode)
  ) {
    return nameNode.text;
  }
  return null;
}

/**
 * Extracts every exported class declaration and its members from a contract or
 * implementation source file. Private (`#` / `private`) members are retained
 * but flagged so callers can filter them.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @param {boolean} isDts
 * @returns {Array<{ className: string, node: import('typescript').ClassDeclaration, extendsError: boolean, members: Map<string, object> }>}
 */
function extractClassInfos(sourceFile, isDts) {
  const classes = [];

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const members = new Map();
      const heritageText = (node.heritageClauses || []).map(clause => clause.getText(sourceFile)).join(' ');
      const extendsError = /\bError\b/.test(heritageText);

      const addMember = (name, kind, line, options = {}) => {
        if (!name) return;
        const isPrivate = Boolean(options.isPrivate || name.startsWith('#'));
        const key = `${options.isStatic ? 'static ' : ''}${name}`;
        if (members.has(key)) return;
        members.set(key, {
          name,
          kind,
          line,
          isStatic: Boolean(options.isStatic),
          isPrivate,
          contractType: options.contractType || null,
          jsDocType: options.jsDocType || null
        });
      };

      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          if (isDts) {
            for (const param of member.parameters) {
              const isParamProp = param.modifiers?.some(mod =>
                [
                  ts.SyntaxKind.PublicKeyword,
                  ts.SyntaxKind.PrivateKeyword,
                  ts.SyntaxKind.ProtectedKeyword,
                  ts.SyntaxKind.ReadonlyKeyword
                ].includes(mod.kind)
              );
              if (!isParamProp) continue;
              addMember(memberNameText(param.name), 'prop', sourceLine(sourceFile, param), {
                isPrivate: hasModifier(param, ts.SyntaxKind.PrivateKeyword)
              });
            }
          }
          continue;
        }

        const name = memberNameText(member.name);
        if (!name) continue;
        const kind = ts.isMethodDeclaration(member)
          ? 'method'
          : ts.isGetAccessor(member)
            ? 'get'
            : ts.isSetAccessor(member)
              ? 'set'
              : ts.isPropertyDeclaration(member)
                ? 'prop'
                : null;
        if (!kind) continue;

        const options = {
          isPrivate: hasModifier(member, ts.SyntaxKind.PrivateKeyword),
          isStatic: hasModifier(member, ts.SyntaxKind.StaticKeyword)
        };
        if (isDts && member.type) options.contractType = member.type.getText(sourceFile);
        if (!isDts) {
          const jsDocType = ts.getJSDocType?.(member);
          if (jsDocType) options.jsDocType = jsDocType.getText(sourceFile);
        }
        addMember(name, kind, sourceLine(sourceFile, member), options);
      }

      if (!isDts) {
        const collectThisAssignments = inner => {
          if (inner !== node && ts.isClassLike(inner)) return;
          if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const left = inner.left;
            if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
              const fieldName = left.name.text;
              if (fieldName && !members.has(fieldName)) {
                addMember(fieldName, 'prop', sourceLine(sourceFile, left), {
                  isPrivate: fieldName.startsWith('#')
                });
              }
            }
          }
          ts.forEachChild(inner, collectThisAssignments);
        };
        for (const member of node.members) ts.forEachChild(member, collectThisAssignments);
      }

      classes.push({ className: node.name.text, node, extendsError, members });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return classes;
}

/**
 * Builds a class-level index over every (.d.ts, .js) contract pair.
 *
 * @param {Array<{ rel: string, dtsPath: string, jsPath: string }>} pairs
 * @returns {Map<string, { className: string, rel: string, dtsPath: string, jsPath: string, extendsError: boolean, contract: Map<string, object>, js: Map<string, object> }>}
 */
function buildContractClassIndex(pairs) {
  const index = new Map();

  for (const pair of pairs) {
    const dtsFile = ts.createSourceFile(
      pair.dtsPath,
      fs.readFileSync(pair.dtsPath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );
    const jsFile = ts.createSourceFile(
      pair.jsPath,
      fs.readFileSync(pair.jsPath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );

    for (const info of extractClassInfos(dtsFile, true)) {
      const entry = index.get(info.className) || {
        className: info.className,
        rel: pair.rel,
        dtsPath: pair.dtsPath,
        jsPath: pair.jsPath,
        extendsError: info.extendsError,
        contract: new Map(),
        js: new Map()
      };
      for (const [key, value] of info.members) entry.contract.set(key, value);
      index.set(info.className, entry);
    }

    for (const info of extractClassInfos(jsFile, false)) {
      const entry = index.get(info.className) || {
        className: info.className,
        rel: pair.rel,
        dtsPath: pair.dtsPath,
        jsPath: pair.jsPath,
        extendsError: info.extendsError,
        contract: new Map(),
        js: new Map()
      };
      entry.extendsError = entry.extendsError || info.extendsError;
      for (const [key, value] of info.members) entry.js.set(key, value);
      index.set(info.className, entry);
    }
  }

  return index;
}

/**
 * P3.1: indexes exported classes from `.ts` implementations so R2/R3 member
 * resolution works identically for `.ts` and `.js` modules. `.ts` classes have
 * no `.d.ts` contract, so their `contract` map stays empty and R1 skips them.
 *
 * @param {Map<string, object>} classIndex
 * @param {Array<{ rel: string, tsPath: string }>} tsFiles
 */
function indexTsImplementationClasses(classIndex, tsFiles) {
  for (const file of tsFiles) {
    const sourceFile = ts.createSourceFile(
      file.tsPath,
      fs.readFileSync(file.tsPath, 'utf-8'),
      ts.ScriptTarget.Latest,
      true
    );

    for (const info of extractClassInfos(sourceFile, false)) {
      const entry = classIndex.get(info.className) || {
        className: info.className,
        rel: file.rel,
        dtsPath: null,
        jsPath: file.tsPath,
        extendsError: info.extendsError,
        contract: new Map(),
        js: new Map()
      };
      entry.extendsError = entry.extendsError || info.extendsError;
      for (const [key, value] of info.members) entry.js.set(key, value);
      classIndex.set(info.className, entry);
    }
  }
}

/**
 * Builds the alias table used to resolve conventional module-instance names.
 *
 * @param {Map<string, object>} classIndex
 * @returns {Map<string, string>}
 */
function buildModuleInstanceAliases(classIndex) {
  const aliases = new Map();
  for (const className of classIndex.keys()) aliases.set(toLowerCamel(className), className);
  for (const [className, names] of MODULE_INSTANCE_ALIAS_HINTS) {
    if (!classIndex.has(className)) continue;
    for (const name of names) aliases.set(name, className);
  }
  return aliases;
}

/**
 * R1: compares class members declared in each `.d.ts` contract against the
 * members implemented by the paired `.js` class. Lifetime-private `#` members
 * are ignored on the implementation side and `private` members on the contract
 * side.
 *
 * @param {Map<string, object>} classIndex
 * @returns {Array<object>}
 */
function verifyClassMemberParity(classIndex) {
  const findings = [];

  for (const entry of classIndex.values()) {
    if (entry.contract.size === 0) continue;
    const jsPath = path.relative(PROJECT_ROOT, entry.jsPath);
    const dtsPath = path.relative(PROJECT_ROOT, entry.dtsPath);

    if (entry.js.size === 0) {
      findings.push({
        file: jsPath,
        line: 1,
        message: `class '${entry.className}' is declared in the contract but no JS implementation class was found`
      });
      continue;
    }

    const jsKeys = new Set(entry.js.keys());
    for (const [key, member] of entry.contract) {
      if (member.isPrivate) continue;
      if (!jsKeys.has(key)) {
        findings.push({
          file: jsPath,
          line: member.line,
          message: `${entry.className}: contract declares '${member.name}' but JS does not implement it (${dtsPath}:${member.line})`
        });
      }
    }

    const contractKeys = new Set(entry.contract.keys());
    for (const [key, member] of entry.js) {
      if (member.isPrivate) continue;
      if (entry.extendsError && ERROR_BASE_MEMBER_NAMES.has(member.name)) continue;
      if (!contractKeys.has(key)) {
        findings.push({
          file: jsPath,
          line: member.line,
          message: `${entry.className}: JS implements public ${member.kind} '${member.name}' absent from the contract ${dtsPath}`
        });
      }
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Lists every runtime source file scanned by the AST boundary rules.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listSourceFiles(dir) {
  const files = [];

  function scan(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist'].includes(entry.name)) scan(full);
      } else if (
        (entry.name.endsWith('.js') || entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  }

  scan(dir);
  return files.sort();
}

/**
 * Blanks everything outside `<script>` blocks while preserving line numbers, so
 * Svelte components can be AST-scanned with the TypeScript parser.
 *
 * @param {string} text
 * @returns {string}
 */
function maskSvelteScripts(text) {
  const chars = text.split('').map(ch => (ch === '\n' ? '\n' : ' '));
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(text))) {
    const inner = match[1];
    const start = match.index + match[0].indexOf(inner);
    for (let i = 0; i < inner.length; i++) chars[start + i] = inner[i];
  }
  return chars.join('');
}

/**
 * @param {string} file
 * @returns {import('typescript').SourceFile}
 */
function parseRuntimeSource(file) {
  let text = fs.readFileSync(file, 'utf-8');
  if (file.endsWith('.svelte')) text = maskSvelteScripts(text);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/**
 * Extracts top-level import bindings.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {Map<string, { specifier: string, imported: string }>}
 */
function extractImportBindings(sourceFile) {
  const imports = new Map();

  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name) imports.set(clause.name.text, { specifier: node.moduleSpecifier.text, imported: 'default' });
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            imports.set(clause.namedBindings.name.text, { specifier: node.moduleSpecifier.text, imported: '*' });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              const imported = (element.propertyName || element.name).text;
              imports.set(element.name.text, { specifier: node.moduleSpecifier.text, imported });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return imports;
}

/**
 * Recursively collects every identifier bound by a binding name / pattern.
 *
 * @param {import('typescript').Node|undefined} name
 * @param {Set<string>} target
 */
function collectBindingNames(name, target) {
  if (!name) return;
  if (ts.isIdentifier(name)) {
    target.add(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) collectBindingNames(element.name, target);
    }
  }
}

/**
 * Collects import bindings, initializer origins, JSDoc type annotations,
 * function parameter types and class field maps for one source file.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @param {Map<string, object>} classIndex
 * @param {Map<string, string>} aliases
 * @returns {object}
 */
function collectFileFacts(sourceFile, classIndex, aliases) {
  const facts = {
    imports: extractImportBindings(sourceFile),
    varOrigins: new Map(),
    varTypes: new Map(),
    functionScopes: new Map(),
    classContexts: new Map(),
    localBindings: new Set(),
    parameterNames: new Set()
  };

  const resolveTypeName = typeText => {
    if (!typeText) return null;
    const tokens = String(typeText).match(/[A-Za-z_$][\w$]*/g) || [];
    for (const token of tokens) if (classIndex.has(token)) return token;
    for (const token of tokens) if (aliases.has(token)) return aliases.get(token);
    return null;
  };

  const addOrigin = (name, expression) => {
    const origins = facts.varOrigins.get(name) || [];
    origins.push(expression);
    facts.varOrigins.set(name, origins);
  };

  function collectFunctionScope(fn) {
    const scope = new Map();
    for (const param of fn.parameters || []) {
      collectBindingNames(param.name, facts.parameterNames);
      collectBindingNames(param.name, facts.localBindings);
      if (!ts.isIdentifier(param.name)) continue;
      let typeName = null;
      for (const tag of ts.getJSDocParameterTags?.(param) || []) {
        if (tag.typeExpression) {
          typeName = resolveTypeName(tag.typeExpression.getText(sourceFile));
          if (typeName) break;
        }
      }
      if (!typeName && param.type) typeName = resolveTypeName(param.type.getText(sourceFile));
      if (typeName) scope.set(param.name.text, typeName);
    }
    return scope;
  }

  function visit(node, currentClass) {
    if (ts.isClassDeclaration(node)) {
      const context = { className: node.name?.text || null, fieldOrigins: new Map(), fieldTypes: new Map() };
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          const jsDocType = ts.getJSDocType?.(member);
          const typeName = jsDocType ? resolveTypeName(jsDocType.getText(sourceFile)) : null;
          if (typeName) context.fieldTypes.set(member.name.text, typeName);
        }
      }
      facts.classContexts.set(node, context);
      for (const member of node.members) visit(member, context);
      return;
    }

    if (ts.isFunctionLike(node) && !facts.functionScopes.has(node)) {
      facts.functionScopes.set(node, collectFunctionScope(node));
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (ts.isIdentifier(left)) addOrigin(left.text, node.right);
      if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && currentClass) {
        const fieldName = left.name.text.replace(/^#/, '');
        if (fieldName && !currentClass.fieldOrigins.has(fieldName)) {
          currentClass.fieldOrigins.set(fieldName, node.right);
        }
      }
    }

    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, facts.localBindings);
    }

    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, facts.localBindings);
      if (ts.isIdentifier(node.name) && node.initializer) {
        addOrigin(node.name.text, node.initializer);
        const parent = node.parent;
        const jsDocType = ts.getJSDocType?.(node) || (parent ? ts.getJSDocType?.(parent.parent) : null);
        if (jsDocType) {
          const typeName = resolveTypeName(jsDocType.getText(sourceFile));
          if (typeName && !facts.varTypes.has(node.name.text)) facts.varTypes.set(node.name.text, typeName);
        }
      }
    }

    ts.forEachChild(node, child => visit(child, currentClass));
  }

  visit(sourceFile, null);
  return facts;
}

/**
 * Resolves whether an expression refers to an imported / known sandbox module
 * instance. Returns `{ module: true, className }` when resolved.
 *
 * @param {import('typescript').SourceFile} sourceFile
 * @param {Map<string, object>} classIndex
 * @param {Map<string, string>} aliases
 * @returns {{ r2: Array<object>, r3: Array<object> }}
 */
function scanBoundaryAccess(sourceFile, classIndex, aliases) {
  const facts = collectFileFacts(sourceFile, classIndex, aliases);
  const r2 = [];
  const r3 = [];
  const scopeStack = [];
  let classCtx = null;

  const resolveTypeName = typeText => {
    if (!typeText) return null;
    const tokens = String(typeText).match(/[A-Za-z_$][\w$]*/g) || [];
    for (const token of tokens) if (classIndex.has(token)) return token;
    for (const token of tokens) if (aliases.has(token)) return aliases.get(token);
    return null;
  };

  const lookupMemberType = (className, memberName) => {
    if (!className) return null;
    const entry = classIndex.get(className);
    if (!entry) return null;
    const contract = entry.contract.get(memberName) || entry.contract.get(`static ${memberName}`);
    if (contract?.contractType) return contract.contractType;
    const implementation = entry.js.get(memberName) || entry.js.get(`static ${memberName}`);
    if (implementation?.jsDocType) return implementation.jsDocType;
    return null;
  };

  const resolveAlias = name => (aliases.has(name) ? { module: true, className: aliases.get(name) } : null);

  const resolveOrigins = (name, seen) => {
    for (const origin of facts.varOrigins.get(name) || []) {
      const resolved = resolveExpression(origin, new Set(seen));
      if (resolved) return resolved;
    }
    return null;
  };

  const resolveIdentifier = (name, seen) => {
    if (!name || name === 'this' || seen.has(name)) return null;
    seen.add(name);

    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const scope = scopeStack[i];
      if (scope?.has(name)) return { module: true, className: scope.get(name) };
    }

    const variableType = resolveTypeName(facts.varTypes.get(name));
    if (variableType) return { module: true, className: variableType };

    const origin = resolveOrigins(name, seen);
    if (origin) return origin;

    const imported = facts.imports.get(name);
    if (imported) {
      const className = classIndex.has(name) ? name : resolveTypeName(imported.imported);
      return { module: true, className };
    }

    // Alias resolution is a last-resort heuristic: a locally bound name whose
    // value could not be resolved is treated as internal data, not a module
    // instance. Function parameters keep the alias fallback because injected
    // instances are conventionally passed as parameters.
    if (!facts.localBindings.has(name) || facts.parameterNames.has(name)) return resolveAlias(name);
    return null;
  };

  const resolveExpression = (expression, seen = new Set()) => {
    if (!expression) return null;
    if (ts.isParenthesizedExpression(expression)) return resolveExpression(expression.expression, seen);
    if (ts.isIdentifier(expression)) return resolveIdentifier(expression.text, seen);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return null;

    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const fieldName = expression.name.text.replace(/^#/, '');
        if (classCtx) {
          const origin = classCtx.fieldOrigins.get(fieldName);
          if (origin) {
            const resolved = resolveExpression(origin, seen);
            if (resolved) return resolved;
          }
          const fieldType = resolveTypeName(classCtx.fieldTypes.get(fieldName));
          if (fieldType) return { module: true, className: fieldType };
        }
        return resolveAlias(fieldName);
      }
      const object = resolveExpression(expression.expression, seen);
      if (object) {
        const memberType = resolveTypeName(lookupMemberType(object.className, expression.name.text));
        if (memberType) return { module: true, className: memberType };
      }
      return resolveAlias(expression.name.text);
    }

    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
      const callee = expression.expression.text;
      if (facts.imports.has(callee)) {
        return {
          module: true,
          className: classIndex.has(callee) ? callee : resolveTypeName(facts.imports.get(callee).imported)
        };
      }
      const origin = resolveOrigins(callee, seen);
      if (origin) return origin;
      return resolveAlias(callee);
    }

    if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (ts.isIdentifier(callee)) {
        if (facts.imports.has(callee.text)) {
          return { module: true, className: classIndex.has(callee.text) ? callee.text : null };
        }
        const origin = resolveOrigins(callee.text, seen);
        if (origin) return origin;
        return resolveAlias(callee.text);
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const object = resolveExpression(callee.expression, seen);
        if (object) {
          const memberType = resolveTypeName(lookupMemberType(object.className, callee.name.text));
          if (memberType) return { module: true, className: memberType };
        }
      }
      return null;
    }

    if (ts.isAwaitExpression(expression)) return resolveExpression(expression.expression, seen);
    return null;
  };

  const walk = node => {
    const previousClass = classCtx;
    if (ts.isClassDeclaration(node)) classCtx = facts.classContexts.get(node) || classCtx;

    let pushedScope = false;
    if (ts.isFunctionLike(node)) {
      scopeStack.push(facts.functionScopes.get(node) || new Map());
      pushedScope = true;
    }

    if (ts.isPropertyAccessExpression(node) && node.name && node.name.text.startsWith('_')) {
      const receiver = node.expression;
      if (receiver.kind !== ts.SyntaxKind.ThisKeyword) {
        const resolved = resolveExpression(receiver);
        if (resolved) {
          r2.push({
            file: path.relative(PROJECT_ROOT, sourceFile.fileName),
            line: sourceLine(sourceFile, node),
            message: `${compactSnippet(sourceFile, node)} -> ${resolved.className || 'module instance'}.${node.name.text}`
          });
        }
      }
    }

    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_KINDS.has(node.operatorToken.kind)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        const property = left.name.text;
        const resolved = resolveExpression(left.expression);
        if (resolved?.className) {
          const declared = declaredMemberSet(resolved.className, classIndex);
          if (declared && !declared.has(property)) {
            r3.push({
              file: path.relative(PROJECT_ROOT, sourceFile.fileName),
              line: sourceLine(sourceFile, left),
              message: `${compactSnippet(sourceFile, node)} -> undeclared '${property}' on ${resolved.className}`
            });
          }
        }
      }
    }

    ts.forEachChild(node, walk);
    if (pushedScope) scopeStack.pop();
    classCtx = previousClass;
  };

  walk(sourceFile);
  return {
    r2: r2.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    r3: r3.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  };
}

/**
 * @param {string} className
 * @param {Map<string, object>} classIndex
 * @returns {Set<string>|null} declared member names, or null when unknown
 */
function declaredMemberSet(className, classIndex) {
  const entry = classIndex.get(className);
  if (!entry) return null;
  const names = new Set();
  for (const member of entry.contract.values()) names.add(member.name);
  for (const member of entry.js.values()) names.add(member.name);
  return names;
}

/**
 * R4: walks tool descriptor schemas and flags `properties` entries that do not
 * declare a JSON-Schema `type`.
 *
 * @returns {Array<object>}
 */
function findToolSchemaTypeGaps() {
  const findings = [];
  const files = [];

  const descriptorsDir = path.join(SANDBOX_DIR, 'tools/descriptors');
  if (fs.existsSync(descriptorsDir)) {
    for (const entry of fs.readdirSync(descriptorsDir)) {
      const isImplementation =
        (entry.endsWith('.js') || entry.endsWith('.ts')) && !entry.endsWith('.d.ts');
      if (isImplementation) files.push(path.join(descriptorsDir, entry));
    }
  }
  for (const facadeName of [
    'toolDefinitions.js',
    'toolDefinitions.ts',
    path.join('toolDefinitions', 'index.ts')
  ]) {
    const facade = path.join(SANDBOX_DIR, facadeName);
    if (fs.existsSync(facade)) files.push(facade);
  }

  const unwrapFreeze = node => {
    let current = node;
    while (
      ts.isCallExpression(current) &&
      current.arguments.length > 0 &&
      current.arguments[0] &&
      /(freeze|seal)$/.test(current.expression.getText())
    ) {
      current = current.arguments[0];
    }
    return current;
  };

  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const rel = path.relative(PROJECT_ROOT, file);

    const checkSchema = schemaNode => {
      for (const property of schemaNode.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = memberNameText(property.name);
        const value = unwrapFreeze(property.initializer);

        if (key === 'properties' && ts.isObjectLiteralExpression(value)) {
          for (const entry of value.properties) {
            if (!ts.isPropertyAssignment(entry)) continue;
            const propName = memberNameText(entry.name);
            const propSchema = unwrapFreeze(entry.initializer);
            if (!ts.isObjectLiteralExpression(propSchema)) continue;
            const keys = propSchema.properties
              .filter(ts.isPropertyAssignment)
              .map(candidate => memberNameText(candidate.name));
            if (!keys.includes('type')) {
              findings.push({
                file: rel,
                line: sourceLine(sourceFile, entry),
                message: `schema property '${propName}' is missing a 'type' declaration`
              });
            }
            checkSchema(propSchema);
          }
        } else if (['items', 'additionalProperties', 'not'].includes(key) && ts.isObjectLiteralExpression(value)) {
          checkSchema(value);
        } else if (['oneOf', 'anyOf', 'allOf'].includes(key) && ts.isArrayLiteralExpression(value)) {
          for (const element of value.elements) {
            const unwrapped = unwrapFreeze(element);
            if (ts.isObjectLiteralExpression(unwrapped)) checkSchema(unwrapped);
          }
        } else if (ts.isObjectLiteralExpression(value)) {
          checkSchema(value);
        }
      }
    };

    const walk = node => {
      if (
        ts.isPropertyAssignment(node) &&
        ['schema', 'parameters'].includes(memberNameText(node.name)) &&
        ts.isObjectLiteralExpression(unwrapFreeze(node.initializer))
      ) {
        checkSchema(unwrapFreeze(node.initializer));
      }
      ts.forEachChild(node, walk);
    };

    walk(sourceFile);
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Executes all P2.7 boundary rules, isolating per-rule failures.
 *
 * @returns {{ totals: Record<string, number>, findings: Record<string, Array<object>>, errors: string[], enforce: boolean }}
 */
function runBoundaryRules() {
  const report = {
    totals: { R1: 0, R2: 0, R3: 0, R4: 0 },
    findings: { R1: [], R2: [], R3: [], R4: [] },
    errors: [],
    enforce: ENFORCE_BOUNDARIES
  };

  let classIndex = new Map();
  let aliases = new Map();
  try {
    classIndex = buildContractClassIndex(findContractModulePairs(SANDBOX_DIR));
    indexTsImplementationClasses(classIndex, findTsImplementationFiles(SANDBOX_DIR));
    aliases = buildModuleInstanceAliases(classIndex);
  } catch (error) {
    report.errors.push(`boundary index build failed: ${error?.message || error}`);
    return report;
  }

  try {
    report.findings.R1 = verifyClassMemberParity(classIndex);
  } catch (error) {
    report.errors.push(`R1 failed: ${error?.message || error}`);
  }

  try {
    const r2 = [];
    const r3 = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const scanned = scanBoundaryAccess(parseRuntimeSource(file), classIndex, aliases);
      r2.push(...scanned.r2);
      r3.push(...scanned.r3);
    }
    report.findings.R2 = r2;
    report.findings.R3 = r3;
  } catch (error) {
    report.errors.push(`R2/R3 failed: ${error?.message || error}`);
  }

  try {
    report.findings.R4 = findToolSchemaTypeGaps();
  } catch (error) {
    report.errors.push(`R4 failed: ${error?.message || error}`);
  }

  for (const rule of ['R1', 'R2', 'R3', 'R4']) report.totals[rule] = report.findings[rule].length;
  return report;
}

/**
 * Prints the appended "Boundary Rules" report section.
 *
 * @param {ReturnType<typeof runBoundaryRules>} report
 */
function printBoundaryRules(report) {
  const ruleLabels = {
    R1: 'Class-member parity (.d.ts vs .js)',
    R2: 'Cross-module underscore access (recv._name)',
    R3: 'Dynamic property writes (foreign instance)',
    R4: 'Tool schema properties missing type'
  };

  log(`\n${BOLD}BOUNDARY RULES (P2.7 extensions):${RESET} ${ENFORCE_BOUNDARIES ? `${RED}enforced${RESET}` : `${YELLOW}warnings only — pass --enforce-boundaries to fail${RESET}`}`);
  log('----------------------------------------------------------------------------------------');

  for (const rule of ['R1', 'R2', 'R3', 'R4']) {
    const findings = report.findings[rule];
    const total = report.totals[rule];
    const status = total === 0 ? `${GREEN}0 (clean)${RESET}` : ENFORCE_BOUNDARIES ? `${RED}${total} violation(s)${RESET}` : `${YELLOW}${total} warning(s)${RESET}`;
    log(`  ${rule} ${ruleLabels[rule].padEnd(50)} : ${status}`);

    const examples = findings.slice(0, BOUNDARY_EXAMPLE_LIMIT);
    for (const finding of examples) {
      log(`       ${DIM}${finding.file}:${finding.line}${RESET}  ${finding.message}`);
    }
    if (findings.length > examples.length) {
      log(`       ${DIM}... ${findings.length - examples.length} more ${rule} finding(s) omitted${RESET}`);
    }
  }

  for (const error of report.errors) {
    log(`  ${RED}boundary analysis error:${RESET} ${error}`);
  }

  if (!ENFORCE_BOUNDARIES) {
    const total = report.totals.R1 + report.totals.R2 + report.totals.R3 + report.totals.R4;
    if (total > 0) {
      log(`  ${DIM}Boundary warnings are informational in default mode; exit code is unaffected.${RESET}`);
    }
  }
}

/**
 * Main verification orchestrator.
 */
function runVerification() {
  log(`\n${BOLD}${CYAN}========================================================================================${RESET}`);
  log(`${BOLD}${CYAN}  THREE-PILLAR SANDBOX CONTRACT VERIFICATION ENGINE${RESET}`);
  log(`${BOLD}${CYAN}  Mathematical Whitelist Proof (E \\ D = ∅) & Boundary Isolation Audit${RESET}`);
  log(`${BOLD}${CYAN}========================================================================================${RESET}\n`);

  const pairs = findContractModulePairs(SANDBOX_DIR);
  const folderModules = findFolderModules(SANDBOX_DIR);
  const folderModuleConflicts = findFolderModuleConflicts(folderModules);
  const siblingConflicts = findSiblingContractConflicts();
  if (folderModules.length === 0) {
    log(`${BOLD}Discovered Sandbox Modules:${RESET} ${pairs.length} modules with (.d.ts, .js) pairs\n`);
  } else {
    log(
      `${BOLD}Discovered Sandbox Modules:${RESET} ${pairs.length} flat (.d.ts, .js) + ` +
        `${folderModules.length} folder (index.ts/index.svelte.ts) = ${pairs.length + folderModules.length}\n`
    );
  }

  let totalDeclared = 0;
  let totalActual = 0;
  let totalMatching = 0;
  let totalLeaked = 0;
  let anyFailure = folderModuleConflicts.length > 0 || siblingConflicts.length > 0;

  const auditRows = [];

  for (const pair of pairs) {
    const D = extractExports(pair.dtsPath, true);
    const E = extractExports(pair.jsPath, false);

    const matching = [];
    const leaked = [];

    for (const exp of E) {
      if (D.has(exp)) {
        matching.push(exp);
      } else {
        leaked.push(exp);
      }
    }

    const passed = leaked.length === 0;
    if (!passed) anyFailure = true;

    totalDeclared += D.size;
    totalActual += E.size;
    totalMatching += matching.length;
    totalLeaked += leaked.length;

    auditRows.push({
      module: pair.rel,
      category: pair.category,
      declaredCount: D.size,
      actualCount: E.size,
      matchingCount: matching.length,
      leakedCount: leaked.length,
      leakedSymbols: leaked,
      matchingSymbols: matching,
      passed
    });
  }

  // Legacy P3.1: `.ts` files still carrying an @contractExports manifest are
  // audited against it; folder-mode surfaces own their contract and skip the
  // hand-`.d.ts` E/D shadow comparison.
  const tsImplementations = auditTsImplementations();
  let totalStale = 0;
  for (const entry of tsImplementations) {
    totalDeclared += entry.declared.size;
    totalActual += entry.actual.size;
    totalMatching += [...entry.actual].filter(symbol => entry.declared.has(symbol)).length;
    totalLeaked += entry.leaked.length;
    totalStale += entry.stale.length;
    if (!entry.passed) anyFailure = true;
  }

  // Print Detailed Table
  log(`${BOLD}MODULE-BY-MODULE CONTRACT AUDIT TABLE:${RESET}`);
  log('--------------------------------------------------------------------------------------------------------');
  log(
    `${'STATUS'.padEnd(8)} | ` +
    `${'MODULE'.padEnd(32)} | ` +
    `${'CATEGORY'.padEnd(19)} | ` +
    `${'DECLARED (D)'.padEnd(13)} | ` +
    `${'ACTUAL (E)'.padEnd(11)} | ` +
    `${'MATCH (E∩D)'.padEnd(12)} | ` +
    `${'LEAKED (E\\D)'}`
  );
  log('--------------------------------------------------------------------------------------------------------');

  for (const row of auditRows) {
    const statusStr = row.passed ? `${GREEN}✔ PASS${RESET}` : `${RED}✖ FAIL${RESET}`;
    const leakedStr = row.leakedCount === 0 ? `${GREEN}0 (∅)${RESET}` : `${RED}${row.leakedSymbols.join(', ')}${RESET}`;

    log(
      `${statusStr.padEnd(17)} | ` +
      `${row.module.padEnd(32)} | ` +
      `${row.category.padEnd(19)} | ` +
      `${String(row.declaredCount).padStart(12)}  | ` +
      `${String(row.actualCount).padStart(10)}  | ` +
      `${String(row.matchingCount).padStart(11)}  | ` +
      `${leakedStr}`
    );
  }
  log('--------------------------------------------------------------------------------------------------------\n');

  printFolderModules(folderModules, folderModuleConflicts, siblingConflicts);

  printTsManifestAudit(tsImplementations);

  // Verify Boundary Isolation
  log(`${BOLD}BOUNDARY ISOLATION AUDIT:${RESET}`);
  const isolation = verifyBoundaryIsolation();
  const legacyViolations = isolation.legacyViolations;
  const deepImportViolations = isolation.deepImportViolations;

  if (legacyViolations.length === 0 && deepImportViolations.length === 0) {
    log(`  ${GREEN}✔ PASS${RESET} Boundary Isolation 100% Enforced: Zero private submodule leaks detected.`);
    log(`         External callers strictly import only from public root facades.`);
    if (folderModules.length > 0) {
      log(`         Folder-mode deep-import ban active across ${folderModules.length} module surface(s).`);
    }
  } else {
    if (legacyViolations.length > 0) {
      log(`  ${RED}✖ FAIL${RESET} ${legacyViolations.length} Boundary Isolation Violations Detected:`);
      for (const v of legacyViolations) {
        log(`    - [${v.file}] imports "${v.imported}": ${v.violation}`);
      }
      anyFailure = true;
    }
    if (deepImportViolations.length > 0) {
      log(`  ${RED}✖ FAIL${RESET} ${deepImportViolations.length} Folder-Mode Deep Import Violations Detected:`);
      for (const v of deepImportViolations) {
        log(`    - [${v.file}] imports "${v.imported}": ${v.violation}`);
      }
      anyFailure = true;
    }
  }

  // Mathematical Proof Summary
  log(`\n${BOLD}${CYAN}========================================================================================${RESET}`);
  log(`${BOLD}MATHEMATICAL INVARIANT PROOF SUMMARY:${RESET}`);
  log(`${BOLD}${CYAN}========================================================================================${RESET}`);
  log(`  Total Modules Checked:       ${pairs.length + folderModules.length + tsImplementations.length}`);
  log(`  Total Declared Symbols (D):  ${totalDeclared}`);
  log(`  Total Actual JS Exports (E): ${totalActual}`);
  log(`  Total Verified Matches:      ${totalMatching}`);
  log(`  Total Leaked Exports (E \\ D): ${totalLeaked === 0 ? `${GREEN}0 (Empty set ∅)${RESET}` : `${RED}${totalLeaked}${RESET}`}`);
  if (tsImplementations.length > 0) {
    log(`  TS Stale Declarations (D \\ E): ${totalStale === 0 ? `${GREEN}0 (Empty set ∅)${RESET}` : `${RED}${totalStale}${RESET}`}`);
  }
  if (folderModules.length > 0) {
    log(`  Folder-Mode Modules:         ${folderModules.length} (contract = index.ts; E \\ D shadow skipped)`);
  }
  log(`  Deep Import Violations:      ${deepImportViolations.length === 0 ? `${GREEN}0 (∅)${RESET}` : `${RED}${deepImportViolations.length}${RESET}`}`);
  log(`  Boundary Isolation Status:   ${legacyViolations.length === 0 && deepImportViolations.length === 0 ? `${GREEN}SECURE (0 leaks)${RESET}` : `${RED}VIOLATED${RESET}`}`);
  log(`  Mathematical Invariant:      ${!anyFailure ? `${GREEN}PROVED: E \\ D = ∅ FOR ALL MODULES${RESET}` : `${RED}FAILED${RESET}`}`);
  log(`${BOLD}${CYAN}========================================================================================${RESET}\n`);

  // P2.7 boundary rules (warnings by default; enforced with --enforce-boundaries)
  const boundaryReport = runBoundaryRules();
  printBoundaryRules(boundaryReport);

  const boundaryTotal =
    boundaryReport.totals.R1 + boundaryReport.totals.R2 + boundaryReport.totals.R3 + boundaryReport.totals.R4;
  const boundaryFailure = ENFORCE_BOUNDARIES && (boundaryTotal > 0 || boundaryReport.errors.length > 0);
  const exitCode = anyFailure || boundaryFailure ? 1 : 0;

  if (JSON_OUTPUT) {
    process.stdout.write(
      `${JSON.stringify(
        {
          invariant: {
            modulesChecked: pairs.length + folderModules.length + tsImplementations.length,
            declared: totalDeclared,
            actual: totalActual,
            matching: totalMatching,
            leaked: totalLeaked,
            stale: totalStale,
            boundaryIsolationViolations: legacyViolations.length,
            deepImportViolations: deepImportViolations.length,
            proved: !anyFailure
          },
          folderModules: folderModules.map(module => ({
            module: module.rel,
            category: module.category,
            surface: path.relative(PROJECT_ROOT, module.surfacePath)
          })),
          deepImports: deepImportViolations,
          siblingContractConflicts: siblingConflicts,
          folderModuleConflicts: folderModuleConflicts,
          tsManifest: tsImplementations.map(entry => ({
            module: entry.module,
            category: entry.category,
            declared: [...entry.declared],
            actual: [...entry.actual],
            leaked: entry.leaked,
            stale: entry.stale,
            messages: entry.messages,
            passed: entry.passed
          })),
          boundary: {
            enforced: ENFORCE_BOUNDARIES,
            totals: boundaryReport.totals,
            findings: boundaryReport.findings,
            errors: boundaryReport.errors
          },
          passed: exitCode === 0
        },
        null,
        2
      )}\n`
    );
  }

  if (exitCode === 1) {
    console.error(`${RED}${BOLD}Contract Verification Failed: One or more invariants violated.${RESET}\n`);
  } else {
    log(`${GREEN}${BOLD}Verification Successful: All sandbox contracts adhere to strict Three-Pillar Isolation.${RESET}\n`);
  }
  process.exit(exitCode);
}

runVerification();
