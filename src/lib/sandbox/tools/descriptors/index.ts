/**
 * @packageDocumentation
 * Module `tools/descriptors`.
 * Master catalog aggregating all 34 canonical tool descriptors and the frozen
 * `TOOL_REGISTRY` table, plus the separate Wave U publishing meta-tool
 * registry (`PUBLISHING_TOOL_REGISTRY`: the two explicit-grant-only tools that
 * are never part of the canonical taxonomy and never wildcard-exposed).
 *
 * Each descriptor pairs a Draft-07 JSON schema, a canonical alias map, a
 * parameter sanitizer, and an async handler bound to the injected substrate of
 * the trusted execution context.
 *
 * @module tools/descriptors
 * @invariant Frozen catalog: every descriptor, schema, alias map, and descriptor array is `Object.freeze`d; `TOOL_REGISTRY` is built once from `ALL_TOOL_DESCRIPTORS` as a null-prototype lookup table and frozen, with no registration or mutation path.
 * @invariant Publishing meta tools: `PUBLISHING_TOOL_REGISTRY` carries exactly the two publishing tools (`import_realm_template`, `submit_hydration_package`), each declaring the explicit authority id (`@template:authority`/`@hydration:authority`) its invocation requires; they are not members of `ALL_TOOL_DESCRIPTORS`/`TOOL_REGISTRY`, their schemas are exposed only through `getPublishingToolSchemas()` for callers holding the matching authority, and the wildcard `'*'`/`privileged` never satisfy them.
 * @invariant Fail-closed precalls: `batch_precall` denies any call whose name does not canonically resolve to a `PRECALL_ALLOWLIST` member, so unresolved or non-allowlisted names never reach the executor.
 * @decision Identity-only caller scope: invocation, lifecycle, and scheduler handlers forward only the dispatcher-bound subject id plus the identity-port principal; per-call caller identity, privilege flags, and role aliases are never read
 * @decision `invoke_agent` pins recursion depth from the trusted bound `currentDepth`, never from a per-call `depth` key
 * @decision VFS and messaging sanitizers strip caller-supplied identity and mailbox-routing keys from the fresh sanitized parameter copy
 * @decision Realm publishing meta tools stay outside the canonical taxonomy (35 names) so no wildcard, preset, or `toolProfile` selector can expose or authorize them; descriptors resolve exclusively through `PUBLISHING_TOOL_REGISTRY`, and the dispatcher consults the caller's frozen authority descriptor for the exact explicit authority
 */

import { vfsToolDescriptors } from './vfsTools.ts';
import { messagingToolDescriptors } from './messagingTools.ts';
import { lifecycleToolDescriptors } from './lifecycleTools.ts';
import { invocationToolDescriptors } from './invocationTools.ts';
import { schedulerToolDescriptors } from './schedulerTools.ts';
import { clockToolDescriptors } from './clockTools.ts';
import { precallToolDescriptors } from './precallTools.ts';
import type { ToolDescriptor } from '../../toolDefinitions/index.ts';

export {
  vfsToolDescriptors,
  readFileDescriptor,
  readFile,
  read_file,
  writeFileDescriptor,
  writeFile,
  write_file,
  replaceFileContentDescriptor,
  replaceFileContent,
  replace_file_content,
  copyFileDescriptor,
  copyFile,
  copy_file,
  deleteFileDescriptor,
  deleteFile,
  delete_file,
  listFilesDescriptor,
  listFiles,
  list_files,
  writeJsonDescriptor,
  writeJson,
  write_json,
  queryJsonDescriptor,
  queryJson,
  query_json,
  jsonPatchDescriptor,
  jsonPatch,
  json_patch,
  grepDescriptor,
  grep,
  setPermissionsDescriptor,
  setPermissions,
  set_permissions
} from './vfsTools.ts';

export {
  messagingToolDescriptors,
  sendMessageDescriptor,
  sendMessage,
  send_message,
  waitForMailDescriptor,
  waitForMail,
  wait_for_mail,
  listInboxDescriptor,
  listInbox,
  list_inbox,
  readMessageDescriptor,
  readMessage,
  read_message,
  getArchiveDescriptor,
  getArchive,
  get_archive,
  inlineFileInMessageDescriptor,
  inlineFileInMessage,
  inline_file_in_message,
  getInboxDescriptor,
  getInbox,
  get_inbox,
  drainInboxDescriptor,
  drainInbox,
  drain_inbox
} from './messagingTools.ts';

export {
  lifecycleToolDescriptors,
  spawnAgentDescriptor,
  spawnAgent,
  spawn_agent,
  killAgentDescriptor,
  killAgent,
  kill_agent,
  listAgentsDescriptor,
  listAgents,
  list_agents,
  whoamiDescriptor,
  whoami,
  undoTurnDescriptor,
  undoTurn,
  undo_turn
} from './lifecycleTools.ts';

export {
  invocationToolDescriptors,
  invokeAgentDescriptor,
  invokeAgent,
  invoke_agent,
  waitForInvocationDescriptor,
  waitForInvocation,
  wait_for_invocation
} from './invocationTools.ts';

export {
  schedulerToolDescriptors,
  scheduleDescriptor,
  schedule,
  listSchedulesDescriptor,
  listSchedules,
  list_schedules,
  cancelScheduleDescriptor,
  cancelSchedule,
  cancel_schedule
} from './schedulerTools.ts';

export {
  clockToolDescriptors,
  worldClockDescriptor,
  worldClock,
  world_clock,
  eventListDescriptor,
  eventList,
  event_list,
  getCurrentTimeDescriptor,
  getCurrentTime,
  get_current_time
} from './clockTools.ts';

export {
  precallToolDescriptors,
  batchPrecallDescriptor,
  batchPrecall,
  batch_precall,
  describeToolDescriptor,
  describeTool,
  describe_tool
} from './precallTools.ts';

export {
  publishingToolDescriptors,
  PUBLISHING_TOOL_REGISTRY,
  getPublishingToolSchemas,
  REALM_PUBLISHING_MAX_FILE_BYTES,
  REALM_PUBLISHING_MAX_BUNDLE_BYTES,
  REALM_PUBLISHING_MAX_PACKAGE_BYTES,
  importRealmTemplateDescriptor,
  importRealmTemplate,
  import_realm_template,
  submitHydrationPackageDescriptor,
  submitHydrationPackage,
  submit_hydration_package
} from './realmTools.ts';
export type { PublishingToolDescriptor } from './realmTools.ts';

/**
 * Array of all 34 Canonical Tool Descriptors
 */
export const ALL_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze([
  ...vfsToolDescriptors,
  ...messagingToolDescriptors,
  ...lifecycleToolDescriptors,
  ...invocationToolDescriptors,
  ...schedulerToolDescriptors,
  ...clockToolDescriptors,
  ...precallToolDescriptors
]);

/**
 * Master Frozen Tool Registry Table (O(1) lookup by canonical snake_case tool name)
 */
const registryObj: Record<string, ToolDescriptor> = Object.create(null);
for (const descriptor of ALL_TOOL_DESCRIPTORS) {
  if (descriptor && descriptor.name) {
    registryObj[descriptor.name] = descriptor;
  }
}

/**
 * Frozen master tool registry: canonical `snake_case` tool name to descriptor,
 * built once from `ALL_TOOL_DESCRIPTORS` as a null-prototype lookup table.
 */
export const TOOL_REGISTRY: Readonly<Record<string, ToolDescriptor>> = Object.freeze(registryObj);
