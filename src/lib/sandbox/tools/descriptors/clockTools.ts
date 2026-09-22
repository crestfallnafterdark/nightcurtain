/**
 * Tool descriptors for World Clock and Simulation Events operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated clockToolDescriptors array.
 */

import { SANDBOX_TOOLS } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a clock descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Time-state fields read by the `get_current_time` fallback. */
interface ClockTimeView {
  formatted?: unknown;
  hour?: number;
  minute?: number;
  second?: number;
  [key: string]: unknown;
}

/** Minimal world-clock substrate view consumed by the clock descriptors. */
interface WorldClockView {
  handleClockTool?(params: ToolParams, context: unknown): unknown;
  handleEventTool?(params: ToolParams, context: unknown): unknown;
  getCurrentTime?(params: ToolParams, context: unknown): unknown;
  getTime(params: ToolParams, context: unknown): ClockTimeView | null | undefined;
  advanceClock(params: ToolParams, context: unknown): unknown;
  setTime(params: ToolParams, context: unknown): unknown;
  resetClock(params: ToolParams, context: unknown): unknown;
  registerEvent(params: ToolParams, context: unknown): unknown;
  resolveEvent(eventId: unknown, context: unknown): unknown;
  cancelEvent(eventId: unknown, context: unknown): unknown;
  queryEvents(params: ToolParams, context: unknown): unknown;
}

// --- 1. world_clock ---
const worldClockParamAliasMap = Object.freeze({
  action: 'action',
  minutes: 'minutes',
  offset_minutes: 'minutes',
  offsetMinutes: 'minutes',
  minutes_offset: 'minutes',
  delta_minutes: 'minutes',
  hours: 'hours',
  offset_hours: 'hours',
  offsetHours: 'hours',
  seconds: 'seconds',
  offset_seconds: 'seconds',
  offsetSeconds: 'seconds',
  time: 'time',
  target_time: 'time',
  targetTime: 'time',
  time_string: 'time'
});

/**
 * `world_clock` descriptor — query, advance, set, or reset the narrative world
 * clock.
 *
 * Args: `action` (defaults to "query"), optional `minutes`, `hours`, `seconds`,
 * `time`. Prefers `context.worldClock.handleClockTool()`, otherwise dispatches to
 * `advanceClock`/`setTime`/`resetClock`/`getTime`; throws when `worldClock` is
 * missing.
 */
export const worldClockDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WORLD_CLOCK,
  description: 'Query, advance, set, or reset the simulation narrative world clock.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'advance', 'set', 'reset'],
        description: 'World clock operation: query current time, advance time, set absolute time, or reset clock.'
      },
      minutes: {
        type: 'number',
        description: 'Minutes delta to advance or minute value to set.'
      },
      hours: {
        type: 'number',
        description: 'Hours delta to advance or hour value to set.'
      },
      seconds: {
        type: 'number',
        description: 'Seconds delta to advance or second value to set.'
      },
      time: {
        type: ['string', 'number'],
        description: 'Absolute time string (e.g. "14:30", "HH:MM:SS") or total seconds.'
      }
    },
    required: ['action'],
    additionalProperties: false
  }),
  paramAliasMap: worldClockParamAliasMap,
  sanitize: createParamSanitizer(worldClockParamAliasMap, { action: 'query' }),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const worldClock = context?.worldClock as WorldClockView | undefined;
    if (!worldClock) {
      throw new Error('worldClock service is not available in execution context');
    }
    if (typeof worldClock.handleClockTool === 'function') {
      return await worldClock.handleClockTool(params, context);
    }

    const action = String(params.action || 'query').toLowerCase();
    switch (action) {
      case 'advance':
        return worldClock.advanceClock(
          { minutes: params.minutes, hours: params.hours, seconds: params.seconds },
          context
        );
      case 'set':
        return worldClock.setTime(
          { time: params.time, minute: params.minutes, hour: params.hours, second: params.seconds },
          context
        );
      case 'reset':
        return worldClock.resetClock({}, context);
      case 'query':
      default:
        return worldClock.getTime({}, context);
    }
  }
});
/** camelCase alias of `worldClockDescriptor`. */
export const worldClock = worldClockDescriptor;
/** snake_case alias of `worldClockDescriptor`. */
export const world_clock = worldClockDescriptor;

// --- 2. event_list ---
const eventListParamAliasMap = Object.freeze({
  action: 'action',
  event_id: 'event_id',
  eventId: 'event_id',
  id: 'event_id',
  name: 'name',
  eventName: 'name',
  event_name: 'name',
  trigger_minutes: 'trigger_minutes',
  triggerMinutes: 'trigger_minutes',
  offset_minutes: 'trigger_minutes',
  offsetMinutes: 'trigger_minutes',
  category: 'category',
  description: 'description'
});

/**
 * `event_list` descriptor — query, register, resolve, or cancel world simulation
 * events.
 *
 * Args: `action` (defaults to "query"), optional `event_id`, `name`,
 * `trigger_minutes`, `category`, `description`. Prefers
 * `context.worldClock.handleEventTool()`, otherwise dispatches to
 * `registerEvent`/`resolveEvent`/`cancelEvent`/`queryEvents`; throws when
 * `worldClock` is missing.
 */
export const eventListDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.EVENT_LIST,
  description: 'Query, register, resolve, or cancel world simulation events.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'register', 'resolve', 'cancel'],
        description: 'Event operation: query events, register a new event, resolve an active event, or cancel an event.'
      },
      event_id: {
        type: 'string',
        description: 'Unique event identifier for resolve or cancel operations.'
      },
      name: {
        type: 'string',
        description: 'Descriptive title or name of the event.'
      },
      trigger_minutes: {
        type: 'number',
        description: 'Relative trigger offset in minutes from current world time.'
      },
      category: {
        type: 'string',
        description: 'Event category or classification (e.g., narrative, encounter, environment).'
      },
      description: {
        type: 'string',
        description: 'Detailed description or narrative notes for the event.'
      }
    },
    required: ['action'],
    additionalProperties: false
  }),
  paramAliasMap: eventListParamAliasMap,
  sanitize: createParamSanitizer(eventListParamAliasMap, { action: 'query' }),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const worldClock = context?.worldClock as WorldClockView | undefined;
    if (!worldClock) {
      throw new Error('worldClock service is not available in execution context');
    }
    if (typeof worldClock.handleEventTool === 'function') {
      return await worldClock.handleEventTool(params, context);
    }

    const action = String(params.action || 'query').toLowerCase();
    switch (action) {
      case 'register':
        return worldClock.registerEvent(
          {
            id: params.event_id,
            name: params.name,
            description: params.description,
            offsetMinutes: params.trigger_minutes,
            category: params.category
          },
          context
        );
      case 'resolve':
        return worldClock.resolveEvent(params.event_id, context);
      case 'cancel':
        return worldClock.cancelEvent(params.event_id, context);
      case 'query':
      default:
        return worldClock.queryEvents(params, context);
    }
  }
});
/** camelCase alias of `eventListDescriptor`. */
export const eventList = eventListDescriptor;
/** snake_case alias of `eventListDescriptor`. */
export const event_list = eventListDescriptor;

// --- 3. get_current_time ---
/**
 * `get_current_time` descriptor — retrieve the current world clock time.
 *
 * Prefers `context.worldClock.getCurrentTime()` and otherwise derives a
 * `time_string` from `getTime()`; throws when `worldClock` is missing.
 */
export const getCurrentTimeDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.GET_CURRENT_TIME,
  description: 'Retrieve current world clock time and formatted timestamp string.',
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: Object.freeze({}),
  sanitize: createParamSanitizer({}),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const worldClock = context?.worldClock as WorldClockView | undefined;
    if (!worldClock) {
      throw new Error('worldClock service is not available in execution context');
    }
    if (typeof worldClock.getCurrentTime === 'function') {
      return await worldClock.getCurrentTime(params, context);
    }
    if (typeof worldClock.getTime === 'function') {
      const time = worldClock.getTime(params, context);
      return {
        ...time,
        time_string: time?.formatted || `${time?.hour ?? 0}:${time?.minute ?? 0}:${time?.second ?? 0}`
      };
    }
    throw new Error('worldClock service is not available in execution context');
  }
});
/** camelCase alias of `getCurrentTimeDescriptor`. */
export const getCurrentTime = getCurrentTimeDescriptor;
/** snake_case alias of `getCurrentTimeDescriptor`. */
export const get_current_time = getCurrentTimeDescriptor;

/**
 * Array of all Clock Tool Descriptors
 */
export const clockToolDescriptors = Object.freeze([
  worldClockDescriptor,
  eventListDescriptor,
  getCurrentTimeDescriptor
]);
