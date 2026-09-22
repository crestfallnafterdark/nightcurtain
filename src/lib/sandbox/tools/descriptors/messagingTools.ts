/**
 * Tool descriptors for Messaging Bus operations conforming to Draft-07 JSON Schema.
 * Exports individual canonical tool descriptors and the consolidated messagingToolDescriptors array.
 */

import { SANDBOX_TOOLS } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import type { ExecutionContext } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a messaging descriptor handler. */
type ToolParams = Record<string, unknown>;

/** Minimal messaging-bus view consumed by the messaging descriptors. */
interface MessagingBusView {
  sendMessage(params: ToolParams, context: unknown): unknown;
  waitForMail(params: ToolParams, context: unknown): unknown;
  listInbox(params: ToolParams, context?: unknown): unknown[];
  readMessage(params: ToolParams, context: unknown): unknown;
  getArchive(params: ToolParams, context: unknown): unknown;
  inlineFileInMessage(params: ToolParams, context: unknown): unknown;
  getInbox?(params: ToolParams, context: unknown): unknown;
  drainInbox(agentId: string | null | undefined, context: unknown): unknown[];
}

/**
 * MOD-21 W10-B / b87de48 defense in depth: all eight messaging descriptors
 * route their arguments through `createMessagingParamSanitizer`, which removes
 * the undeclared identity/mailbox-routing spellings in this set — including
 * the alias spellings the bus itself reads as sender/mailbox selectors — from
 * the sanitized parameter copy handed to a handler. The dispatcher binds the
 * only legitimate caller identity (`context.callerAgentId`); a tool argument
 * must not select a mailbox, sender, or VirtualFS read identity. Declared
 * parameters (`recipient` on `send_message`/`inline_file_in_message`, the
 * `sender` filter on `wait_for_mail`) and their canonical aliases are
 * preserved. The scrub is a descriptor-boundary guarantee; it does not replace
 * the bus's own context-bound identity resolution. Mirrors
 * `scrubIdentityParams` in `vfsTools.ts`.
 */
const IDENTITY_ROUTING_PARAM_KEYS = Object.freeze([
  'from',
  'from_agent',
  'fromAgent',
  'sender',
  'sender_id',
  'senderId',
  'senders',
  'agentId',
  'agent_id',
  'callerAgentId',
  'caller_agent_id',
  'recipient',
  'recipientId',
  'recipient_id',
  'targetAgentId',
  'target_agent_id',
  'targetAgent',
  'target_agent',
  'workspaceId',
  'workspace_id'
]);

/**
 * Builds a messaging descriptor sanitizer that removes undeclared identity and
 * mailbox-routing keys from the sanitized parameter copy. The copy is fresh
 * (produced by `createParamSanitizer`), so scrubbing never mutates caller
 * input.
 * @param paramAliasMap - Optional alias map applied before scrubbing
 * @param declaredKeys - Canonical identity-shaped keys the schema declares
 * @returns A sanitizer that returns a fresh scrubbed parameter copy
 */
function createMessagingParamSanitizer(
  paramAliasMap: Record<string, string> = {},
  declaredKeys: string[] = []
): (rawArgs?: unknown) => Record<string, unknown> {
  const sanitize = createParamSanitizer(paramAliasMap);
  const declared = new Set(declaredKeys);
  return (rawArgs?: unknown): Record<string, unknown> => {
    const sanitized = sanitize(rawArgs);
    for (const key of IDENTITY_ROUTING_PARAM_KEYS) {
      if (!declared.has(key)) delete sanitized[key];
    }
    return sanitized;
  };
}

// --- 1. send_message ---
const sendMessageParamAliasMap = Object.freeze({
  to: 'recipient',
  targetAgentId: 'recipient',
  target_agent_id: 'recipient',
  recipient_id: 'recipient',
  recipientId: 'recipient',
  body: 'message',
  content: 'message',
  text: 'message',
  payload: 'message',
  inReplyTo: 'in_reply_to',
  in_reply_to: 'in_reply_to',
  replyTo: 'in_reply_to',
  reply_to: 'in_reply_to',
  correlationId: 'correlation_id',
  correlation_id: 'correlation_id'
});

/**
 * `send_message` descriptor — send a message to an agent mailbox or broadcast
 * with recipient "all".
 *
 * Args: `recipient`, `message` (both required), optional `in_reply_to` and
 * `correlation_id`. Delegates to `context.messagingBus.sendMessage()` and throws
 * when that service is missing.
 */
export const sendMessageDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.SEND_MESSAGE,
  description: 'Send a message to an agent mailbox or broadcast to all agents.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description: 'Target agent ID or "all" for broadcast.'
      },
      message: {
        type: 'string',
        description: 'Message payload text or content to deliver.'
      },
      in_reply_to: {
        type: 'string',
        description: 'Optional message ID being replied to.'
      },
      correlation_id: {
        type: 'string',
        description: 'Optional correlation tracking identifier.'
      }
    },
    required: ['recipient', 'message'],
    additionalProperties: false
  }),
  paramAliasMap: sendMessageParamAliasMap,
  sanitize: createMessagingParamSanitizer(sendMessageParamAliasMap, ['recipient']),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.sendMessage !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.sendMessage(params, context);
  }
});
/** camelCase alias of `sendMessageDescriptor`. */
export const sendMessage = sendMessageDescriptor;
/** snake_case alias of `sendMessageDescriptor`. */
export const send_message = sendMessageDescriptor;

// --- 2. wait_for_mail ---
const waitForMailParamAliasMap = Object.freeze({
  timeoutMs: 'timeout_ms',
  timeout_ms: 'timeout_ms',
  timeout: 'timeout_ms',
  from: 'sender',
  sender_id: 'sender',
  senderId: 'sender',
  from_agent: 'sender',
  fromAgent: 'sender',
  sender: 'sender'
});

/**
 * `wait_for_mail` descriptor — wait asynchronously for incoming mail.
 *
 * Args: optional `timeout_ms` and `sender` filter. Delegates to
 * `context.messagingBus.waitForMail()` and throws when that service is missing.
 */
export const waitForMailDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.WAIT_FOR_MAIL,
  description: 'Wait asynchronously for incoming mail or messages from specified senders.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      timeout_ms: {
        type: 'integer',
        description: 'Maximum time to wait in milliseconds.'
      },
      sender: {
        type: 'string',
        description: 'Optional sender agent ID to filter incoming messages.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: waitForMailParamAliasMap,
  sanitize: createMessagingParamSanitizer(waitForMailParamAliasMap, ['sender']),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.waitForMail !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.waitForMail(params, context);
  }
});
/** camelCase alias of `waitForMailDescriptor`. */
export const waitForMail = waitForMailDescriptor;
/** snake_case alias of `waitForMailDescriptor`. */
export const wait_for_mail = waitForMailDescriptor;

// --- 3. list_inbox ---
const listInboxParamAliasMap = Object.freeze({
  unreadOnly: 'unread_only',
  unread_only: 'unread_only',
  unread: 'unread_only',
  max: 'limit',
  count: 'limit',
  pageSize: 'limit',
  page_size: 'limit'
});

/**
 * `list_inbox` descriptor — list pending messages in the bound caller's inbox.
 *
 * Args: optional `unread_only` and `limit`. Delegates to
 * `context.messagingBus.listInbox()` and throws when that service is missing.
 */
export const listInboxDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.LIST_INBOX,
  description: "List pending messages in the calling agent's inbox.",
  schema: Object.freeze({
    type: 'object',
    properties: {
      unread_only: {
        type: 'boolean',
        description: 'Whether to list only unread messages.'
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of messages to return.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: listInboxParamAliasMap,
  sanitize: createMessagingParamSanitizer(listInboxParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.listInbox !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.listInbox(params, context);
  }
});
/** camelCase alias of `listInboxDescriptor`. */
export const listInbox = listInboxDescriptor;
/** snake_case alias of `listInboxDescriptor`. */
export const list_inbox = listInboxDescriptor;

// --- 4. read_message ---
const readMessageParamAliasMap = Object.freeze({
  messageId: 'message_id',
  message_id: 'message_id',
  msgId: 'message_id',
  msg_id: 'message_id',
  id: 'message_id',
  markAsRead: 'mark_as_read',
  mark_as_read: 'mark_as_read',
  markRead: 'mark_as_read',
  mark_read: 'mark_as_read'
});

/**
 * `read_message` descriptor — read one inbox message by its message ID.
 *
 * Args: `message_id` (required), optional `mark_as_read`. Delegates to
 * `context.messagingBus.readMessage()` and throws when that service is missing.
 */
export const readMessageDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.READ_MESSAGE,
  description: 'Read a specific message from the inbox by its message ID.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Unique identifier of the message to read.'
      },
      mark_as_read: {
        type: 'boolean',
        description: 'Whether to mark the message as read (defaults to true).'
      }
    },
    required: ['message_id'],
    additionalProperties: false
  }),
  paramAliasMap: readMessageParamAliasMap,
  sanitize: createMessagingParamSanitizer(readMessageParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.readMessage !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.readMessage(params, context);
  }
});
/** camelCase alias of `readMessageDescriptor`. */
export const readMessage = readMessageDescriptor;
/** snake_case alias of `readMessageDescriptor`. */
export const read_message = readMessageDescriptor;

// --- 5. get_archive ---
const getArchiveParamAliasMap = Object.freeze({
  max: 'limit',
  count: 'limit',
  skip: 'offset',
  pageSize: 'limit',
  page_size: 'limit'
});

/**
 * `get_archive` descriptor — retrieve archived historical messages that were
 * previously consumed.
 *
 * Args: optional `limit` and `offset`. Delegates to
 * `context.messagingBus.getArchive()` and throws when that service is missing.
 */
export const getArchiveDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.GET_ARCHIVE,
  description: 'Retrieve archived historical messages that were previously consumed.',
  schema: Object.freeze({
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Maximum number of archived messages to return.'
      },
      offset: {
        type: 'integer',
        description: 'Pagination offset for skipping messages.'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: getArchiveParamAliasMap,
  sanitize: createMessagingParamSanitizer(getArchiveParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.getArchive !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.getArchive(params, context);
  }
});
/** camelCase alias of `getArchiveDescriptor`. */
export const getArchive = getArchiveDescriptor;
/** snake_case alias of `getArchiveDescriptor`. */
export const get_archive = getArchiveDescriptor;

// --- 6. inline_file_in_message ---
const inlineFileInMessageParamAliasMap = Object.freeze({
  filePath: 'file_path',
  file_path: 'file_path',
  path: 'file_path',
  target_agent_id: 'recipient',
  targetAgentId: 'recipient',
  recipient_id: 'recipient',
  recipientId: 'recipient',
  to: 'recipient',
  body: 'message',
  content: 'message',
  text: 'message'
});

/**
 * Agent-facing path guidance for inlined files (ticket cf5e707): the file path
 * resolves through the caller's workspace view — `/` is the private
 * workspace, `/global/...` is the shared workspace, and `/agents/<agentId>/...`
 * mounts another agent's private workspace. Mirrors the VFS descriptor wording.
 */
const PATH_VIEW_HELP =
  '"/" is your private workspace, "/global/..." is the shared workspace visible to every agent in your scope, and "/agents/<agentId>/..." mounts another agent\'s private workspace (authority required).';

/**
 * `inline_file_in_message` descriptor — read a virtual filesystem file and embed
 * its content in a message to a recipient.
 *
 * Args: `file_path`, `recipient` (both required), optional `message`. Delegates
 * to `context.messagingBus.inlineFileInMessage()` and throws when that service is
 * missing.
 *
 * The path is resolved through the caller's workspace view by the VirtualFS:
 * private by default, `/global/...` for the shared workspace, and
 * `/agents/<agentId>/...` for an authorized peer mount. The delegated bus read
 * carries the pinned caller identity and private-workspace binding, never a
 * tool-argument workspace claim (tickets a50f109, cf5e707).
 */
export const inlineFileInMessageDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  description: `Read a virtual filesystem file and embed its content directly into a message sent to a recipient. ${PATH_VIEW_HELP}`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: `Path of the virtual file to inline. ${PATH_VIEW_HELP}`
      },
      recipient: {
        type: 'string',
        description: 'Target recipient agent ID.'
      },
      message: {
        type: 'string',
        description: 'Optional accompanying message text or template.'
      }
    },
    required: ['file_path', 'recipient'],
    additionalProperties: false
  }),
  paramAliasMap: inlineFileInMessageParamAliasMap,
  sanitize: createMessagingParamSanitizer(inlineFileInMessageParamAliasMap, ['recipient']),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.inlineFileInMessage !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    return await bus.inlineFileInMessage(params, context);
  }
});
/** camelCase alias of `inlineFileInMessageDescriptor`. */
export const inlineFileInMessage = inlineFileInMessageDescriptor;
/** snake_case alias of `inlineFileInMessageDescriptor`. */
export const inline_file_in_message = inlineFileInMessageDescriptor;

// --- 7. get_inbox ---
const getInboxParamAliasMap = Object.freeze({
  markAsRead: 'mark_as_read',
  mark_as_read: 'mark_as_read',
  markRead: 'mark_as_read',
  mark_read: 'mark_as_read'
});

/**
 * `get_inbox` descriptor — retrieve unread messages for the bound caller.
 *
 * Args: optional `mark_as_read`. Prefers `context.messagingBus.getInbox()` and
 * otherwise composes `drainInbox()`/`listInbox()`; returns
 * `{success, deliveryNote, count, messages}` and throws when `messagingBus` is
 * missing.
 */
export const getInboxDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.GET_INBOX,
  description: "Retrieve all unread messages from the calling agent's inbox, with option to mark as read.",
  schema: Object.freeze({
    type: 'object',
    properties: {
      mark_as_read: {
        type: 'boolean',
        description: 'Whether to mark the messages as read (defaults to false).'
      }
    },
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: getInboxParamAliasMap,
  sanitize: createMessagingParamSanitizer(getInboxParamAliasMap),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus) {
      throw new Error('messagingBus service is not available in execution context');
    }
    if (typeof bus.getInbox === 'function') {
      return await bus.getInbox(params, context);
    }
    // The dispatcher pins `callerAgentId` from bound construction only; the
    // nested `callerContext.agentId` key is caller data and is never consulted.
    const agentId = context?.callerAgentId || context?.agentId;
    const markRead = params.mark_as_read === true || params.markAsRead === true || String(params.mark_as_read) === 'true' || String(params.markAsRead) === 'true';
    if (markRead) {
      const messages = bus.drainInbox(agentId, context);
      return {
        success: true,
        deliveryNote: 'Inbox retrieved and marked as read. All message contents delivered in full.',
        count: messages.length,
        messages
      };
    } else {
      const headers = bus.listInbox({ agentId, unread_only: true });
      return {
        success: true,
        deliveryNote: 'Inbox retrieved. All message contents delivered in full.',
        count: headers.length,
        messages: headers
      };
    }
  }
});
/** camelCase alias of `getInboxDescriptor`. */
export const getInbox = getInboxDescriptor;
/** snake_case alias of `getInboxDescriptor`. */
export const get_inbox = getInboxDescriptor;

// --- 8. drain_inbox ---
/**
 * `drain_inbox` descriptor — atomically retrieve and drain all pending messages
 * for the bound caller.
 *
 * Delegates to `context.messagingBus.drainInbox()` and returns
 * `{success, deliveryNote, count, messages}`; throws when `messagingBus` is
 * missing.
 */
export const drainInboxDescriptor = Object.freeze({
  name: SANDBOX_TOOLS.DRAIN_INBOX,
  description: "Atomically retrieve and drain all pending unread messages from the calling agent's inbox.",
  schema: Object.freeze({
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }),
  paramAliasMap: Object.freeze({}),
  sanitize: createMessagingParamSanitizer({}),
  handler: async (params: ToolParams, context: ExecutionContext) => {
    const bus = context?.messagingBus as MessagingBusView | undefined;
    if (!bus || typeof bus.drainInbox !== 'function') {
      throw new Error('messagingBus service is not available in execution context');
    }
    // The dispatcher pins `callerAgentId` from bound construction only; the
    // nested `callerContext.agentId` key is caller data and is never consulted.
    const agentId = context?.callerAgentId || context?.agentId;
    const messages = bus.drainInbox(agentId, context);
    return {
      success: true,
      deliveryNote: 'Inbox drained. All message contents delivered in full.',
      count: messages.length,
      messages
    };
  }
});
/** camelCase alias of `drainInboxDescriptor`. */
export const drainInbox = drainInboxDescriptor;
/** snake_case alias of `drainInboxDescriptor`. */
export const drain_inbox = drainInboxDescriptor;

/**
 * Array of all 8 Messaging Tool Descriptors
 */
export const messagingToolDescriptors = Object.freeze([
  sendMessageDescriptor,
  waitForMailDescriptor,
  listInboxDescriptor,
  readMessageDescriptor,
  getArchiveDescriptor,
  inlineFileInMessageDescriptor,
  getInboxDescriptor,
  drainInboxDescriptor
]);
