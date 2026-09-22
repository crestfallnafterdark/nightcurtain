/**
 * @packageDocumentation
 * Module `tools/normalizers`.
 * Tool-name normalization substrate: the master alias map, the canonical tool resolver, the
 * ratified precall allowlist, and the table-driven parameter sanitizer factory consumed by the
 * sandbox tool descriptors.
 *
 * @module tools/normalizers
 * @invariant Prototype-pollution-safe resolution: alias lookups read only own keys of the frozen alias map (`hasOwnProperty`-guarded) and of a prototype-free `Object.create(null)` lowercased dictionary; non-string or unresolvable input resolves to `null`, and the sanitizer drops `__proto__`/`constructor`/`prototype` on both source and target keys.
 * @invariant Failure-safe sanitization: `createParamSanitizer` never throws and never mutates its configured `defaults`; invalid, absent, non-object, or array arguments return a fresh shallow copy of `defaults`, and `null`/`undefined` values are skipped.
 * @invariant Precall allowlist policy: `PRECALL_ALLOWLIST` is frozen and holds exactly 14 canonical tool names, each resolvable by `getCanonToolName`; every tool outside the set is denied by the `batch_precall` descriptor (`PRECALL_FORBIDDEN`) and by the turn-execution precall gate (`FORBIDDEN_PRECALL`).
 */

export { TOOL_ALIAS_MAP, getCanonToolName, normalizeToolName, PRECALL_ALLOWLIST } from './aliasMap.ts';
export { toSnakeCase, toCamelCase, createParamSanitizer } from './paramSanitizer.ts';
