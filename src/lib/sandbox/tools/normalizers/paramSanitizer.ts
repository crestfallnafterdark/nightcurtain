/**
 * Table-driven parameter sanitization factory, case transformers, and resilient schema argument mapping.
 * Private implementation detail of the `tools/normalizers` module; the public surface is `index.ts`.
 */

/**
 * Converts camelCase, PascalCase, or kebab-case string to snake_case.
 *
 * @param str - Input value; non-strings and empty values yield an empty string.
 * @returns The snake_case form of the input, or an empty string for non-string/empty input.
 */
export function toSnakeCase(str: unknown): string {
  if (typeof str !== 'string' || !str) return '';
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

/**
 * Converts snake_case, kebab-case, or PascalCase string to camelCase.
 *
 * @param str - Input value; non-strings and empty values yield an empty string.
 * @returns The camelCase form of the input, or an empty string for non-string/empty input.
 */
export function toCamelCase(str: unknown): string {
  if (typeof str !== 'string' || !str) return '';
  const s = str
    .replace(/^[-_\s]+/, '')
    .replace(/[-_\s]+([a-zA-Z0-9])/g, (_, char) => char.toUpperCase());
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Factory creating a parameter sanitizer function with pre-configured alias mappings and defaults.
 *
 * @param paramAliasMap - Mapping from incoming param names/aliases to canonical property names; defaults to an empty map.
 * @param defaults - Default property values applied when the sanitized input omits them; the object is never mutated.
 * @returns A sanitizer function that accepts raw arguments (object, JSON string, or arbitrary value) and returns a fresh sanitized parameters object.
 */
export function createParamSanitizer(
  paramAliasMap: Record<string, string> = {},
  defaults: Record<string, unknown> = {}
): (rawArgs?: unknown) => Record<string, unknown> {
  return function sanitizeParams(rawArgs = {}) {
    let parsedArgs = rawArgs;

    if (typeof rawArgs === 'string') {
      const trimmed = rawArgs.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          parsedArgs = JSON.parse(trimmed);
        } catch {
          parsedArgs = null;
        }
      } else {
        parsedArgs = null;
      }
    }

    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      return { ...defaults };
    }

    const result = { ...defaults };

    for (const [key, value] of Object.entries(parsedArgs)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      let targetKey;
      if (paramAliasMap && Object.prototype.hasOwnProperty.call(paramAliasMap, key)) {
        targetKey = paramAliasMap[key];
      } else {
        const snakeKey = toSnakeCase(key);
        if (paramAliasMap && Object.prototype.hasOwnProperty.call(paramAliasMap, snakeKey)) {
          targetKey = paramAliasMap[snakeKey];
        } else {
          targetKey = snakeKey;
        }
      }

      if (targetKey && targetKey !== '__proto__' && targetKey !== 'constructor' && targetKey !== 'prototype') {
        result[targetKey] = value;
      }
    }

    return result;
  };
}

/**
 * Factory creating a pass-through parameter sanitizer for dynamically discovered
 * (extension) tools, whose wire argument names must reach the server exactly as
 * the caller sent them.
 *
 * Unlike {@link createParamSanitizer}, the returned function never renames or
 * drops wire keys: no alias mapping, no snake_case rewriting, no defaults, and
 * no declared-key filtering. It accepts the same input shapes as
 * `createParamSanitizer` (a plain object, a JSON object/array string, or any
 * other value) and always returns a fresh plain object. Only the
 * prototype-pollution vocabulary (`__proto__`, `constructor`, `prototype`) is
 * dropped; `undefined` members are omitted because JSON cannot represent them,
 * while `null` is preserved as a legitimate wire value. Invalid, absent,
 * array, or unparseable input yields an empty object.
 *
 * @returns A sanitizer function that accepts raw arguments and returns a fresh pass-through parameters object.
 *
 * @example
 * ```typescript
 * import { createPassThroughSanitizer } from './tools/normalizers/index.ts';
 *
 * const sanitize = createPassThroughSanitizer();
 * sanitize('{"topK": 5, "snake_key": true}');
 * // => { topK: 5, snake_key: true } (verbatim keys, no snake_case rewriting)
 * ```
 */
export function createPassThroughSanitizer(): (rawArgs?: unknown) => Record<string, unknown> {
  return function sanitizePassThroughParams(rawArgs = {}) {
    let parsedArgs = rawArgs;

    if (typeof rawArgs === 'string') {
      const trimmed = rawArgs.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          parsedArgs = JSON.parse(trimmed);
        } catch {
          parsedArgs = null;
        }
      } else {
        parsedArgs = null;
      }
    }

    if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
      return {};
    }

    const result: Record<string, unknown> = {};

    try {
      for (const [key, value] of Object.entries(parsedArgs)) {
        if (value === undefined) {
          continue;
        }
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        result[key] = value;
      }
    } catch {
      // A hostile accessor (or proxy trap) on the argument object must never
      // escape: the sanitizer stays total and fails closed to an empty object.
      return {};
    }

    return result;
  };
}
