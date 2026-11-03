import { createExport, normalizeOptions, ExportError, DEFAULT_MAX_EXPORT_BYTES } from './export-core.js';

export const EXPORT_PATH = '/api/conversation-export';
export const TOOL_NAME = 'export_conversation';
export const MAX_CONFIG_BYTES = 1024 * 1024 * 1024;

export const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxExportBytes: {
      type: 'integer', minimum: 1, maximum: MAX_CONFIG_BYTES,
      default: DEFAULT_MAX_EXPORT_BYTES,
      description: 'Maximum UTF-8 export size in bytes. Oversized exports fail without truncation.',
    },
  },
};

export function validateConfig(input) {
  const value = input ?? {};
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'maxExportBytes')) {
    throw new TypeError('Expected configuration with only maxExportBytes.');
  }
  const maxExportBytes = value.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes < 1 || maxExportBytes > MAX_CONFIG_BYTES) {
    throw new TypeError('maxExportBytes must be an integer from 1 to 1073741824.');
  }
  return { maxExportBytes };
}

function unauthorized() {
  return new ExportError('UNAUTHORIZED', 'This conversation is not available to the caller.', 403);
}

function assertAuthority(authority, targetId, header) {
  if (authority?.kind === 'browser-owner') {
    if (header && header.id !== targetId) {
      throw new ExportError('INVALID_OBSERVATION', 'The history does not match the requested conversation.', 500);
    }
    return;
  }
  if (authority?.kind !== 'agent' || typeof authority.sessionId !== 'string' || !authority.sessionId) {
    throw unauthorized();
  }
  if (targetId !== authority.sessionId && authority.cwd === undefined) throw unauthorized();
  if (header && (header.id !== targetId || header.cwd !== authority.cwd)) throw unauthorized();
}

/** One read-only implementation for both the authenticated download and the agent tool. */
export class ConversationExportService {
  constructor(query, config = {}, clock = Date.now) {
    this.query = query;
    this.config = validateConfig(config);
    this.clock = clock;
    this.abort = new AbortController();
    this.active = new Set();
  }

  exportConversation(rawOptions, authority, callerSignal) {
    const operation = this.run(rawOptions, authority, callerSignal);
    this.active.add(operation);
    operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
    return operation;
  }

  async run(rawOptions, authority, callerSignal) {
    const options = normalizeOptions(rawOptions);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.abort.signal])
      : this.abort.signal;
    signal.throwIfAborted();
    assertAuthority(authority, options.sessionId);
    // Match the first-party session-query tool boundary, including its metadata precheck.
    if (authority.kind === 'agent' && options.sessionId !== authority.sessionId) {
      try {
        const candidates = await this.query.filterSessions([
          { kind: 'id', values: [options.sessionId] },
          { kind: 'cwd', values: [authority.cwd] },
        ], signal);
        if (candidates.length !== 1 || candidates[0].header?.id !== options.sessionId ||
            candidates[0].header?.cwd !== authority.cwd) throw unauthorized();
      } catch (error) {
        signal.throwIfAborted();
        // An unknown id and an inaccessible id must not reveal different information.
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw unauthorized();
        throw error;
      }
    }
    signal.throwIfAborted();
    const observation = await this.query.observeSession(options.sessionId, {
      signal, projectionMode: 'none',
    });
    try {
      signal.throwIfAborted();
      // Recheck the exact observed identity before touching lazy event bodies.
      assertAuthority(authority, options.sessionId, observation.header);
      const result = createExport(observation, options, {
        maxExportBytes: this.config.maxExportBytes,
        now: this.clock(),
      });
      signal.throwIfAborted();
      return result;
    } finally {
      observation[Symbol.dispose]();
    }
  }

  async dispose() {
    this.abort.abort(new DOMException('Conversation Export was unloaded.', 'AbortError'));
    await Promise.allSettled([...this.active]);
  }
}

/** Never send filesystem paths, stack traces, provider state or raw backend errors. */
export function publicError(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'SESSION_QUERY_ABORTED') {
    return new ExportError('ABORTED', 'The export was cancelled.', 499);
  }
  if (error instanceof ExportError) return error;
  switch (error?.code) {
    case 'SESSION_QUERY_SESSION_NOT_FOUND':
    case 'SESSION_PERSISTENCE_NOT_FOUND':
      return new ExportError('SESSION_NOT_FOUND', 'The conversation was not found.', 404);
    case 'SESSION_QUERY_PERSISTENCE_FAILED':
      return new ExportError('HISTORY_UNAVAILABLE', 'The conversation history cannot be read right now.', 503);
    case 'SESSION_QUERY_CORRUPT_SESSION':
    case 'SESSION_QUERY_INVALID_SURFACE':
    case 'SESSION_QUERY_SOURCE_CONFLICT':
      return new ExportError('INVALID_OBSERVATION', 'The conversation history could not be validated.', 422);
    default:
      if (typeof error?.code === 'string' && /^(SESSION_FORMAT_|SESSION_PERSISTENCE_.*(?:VERSION|FORMAT|MIGRATION))/.test(error.code)) {
        return new ExportError('UNSUPPORTED_HISTORY', 'This conversation format is not supported by the current Harness.', 422);
      }
      return new ExportError('EXPORT_FAILED', 'The conversation could not be exported. Please retry.', 500);
  }
}

function parseQuery(request) {
  const url = new URL(request.url);
  const allowed = new Set(['sessionId', 'format', 'includeTools']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ExportError('INVALID_PARAMS', 'Unknown or repeated export parameter.', 400);
    }
  }
  const includeTools = url.searchParams.get('includeTools');
  if (includeTools !== null && includeTools !== 'true' && includeTools !== 'false') {
    throw new ExportError('INVALID_PARAMS', 'includeTools must be true or false.', 400);
  }
  return normalizeOptions({
    sessionId: url.searchParams.get('sessionId'),
    format: url.searchParams.get('format'),
    includeTools: includeTools === 'true',
  });
}

function disposition(filename, format) {
  // Defense in depth: never put raw titles or user input in HTTP headers.
  const safe = filename.replace(/[\r\n\u0000-\u001f\u007f]/g, '_').toWellFormed();
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="conversation.${format === 'json' ? 'json' : 'md'}"; filename*=UTF-8''${encoded}`;
}

const privateHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function createDownloadHandler(service) {
  return async request => {
    try {
      if (request.method !== 'GET') {
        return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this export.' } }, {
          status: 405, headers: { ...privateHeaders, allow: 'GET' },
        });
      }
      const options = parseQuery(request);
      // Connection admits only authenticated owner Peers to exact Fetch routes.
      const result = await service.exportConversation(options, { kind: 'browser-owner' }, request.signal);
      request.signal.throwIfAborted();
      return new Response(result.content, {
        headers: {
          ...privateHeaders,
          'content-type': result.mimeType,
          'content-disposition': disposition(result.filename, options.format),
          'content-length': String(result.bytes),
          'x-dsh-export-messages': String(result.messageCount),
          'x-dsh-export-warnings': String(result.warnings.length),
        },
      });
    } catch (error) {
      const failure = publicError(error, request.signal);
      return Response.json({ error: { code: failure.code, message: failure.message } }, {
        status: failure.status, headers: privateHeaders,
      });
    }
  };
}

function toolOptions(args, agent) {
  if (!agent?.session?.header || !agent.session.id) throw unauthorized();
  if (args === null || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !['session_id', 'format', 'include_tools'].includes(key))) {
    throw new ExportError('INVALID_PARAMS', 'Expected session_id, format and include_tools.', 400);
  }
  return normalizeOptions({
    sessionId: args.session_id === undefined ? agent.session.id : args.session_id,
    format: args.format,
    includeTools: args.include_tools === undefined ? false : args.include_tools,
  });
}

export function createExportTool(service, spillStore) {
  return {
    name: TOOL_NAME,
    description: 'Export an authorized conversation as JSON or Markdown to a temporary file. Returns its location and summary, not the entire transcript.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: 'Session to export. Omit for the current session; another session must belong to the same workspace.' },
        format: { type: 'string', enum: ['json', 'markdown'], description: 'Export file format.' },
        include_tools: { type: 'boolean', description: 'Include tool calls and results, which may contain sensitive data. Defaults to false. Reasoning and binary attachments are excluded.' },
      },
      required: ['format'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          filename: { type: 'string' },
          mimeType: { type: 'string' },
          locator: { type: 'string' },
          retrievalHint: { type: 'string' },
          temporary: { type: 'boolean' },
          bytes: { type: 'integer' },
          messageCount: { type: 'integer' },
          capturedThroughSeq: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          warnings: {
            type: 'array', items: {
              type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } },
              required: ['code', 'message'], additionalProperties: false,
            },
          },
        },
        required: ['sessionId', 'filename', 'mimeType', 'locator', 'retrievalHint', 'temporary', 'bytes', 'messageCount', 'capturedThroughSeq', 'warnings'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        exec.signal.throwIfAborted();
        const options = toolOptions(args, exec.agent);
        const caller = exec.agent.session;
        const result = await service.exportConversation(options, {
          kind: 'agent', sessionId: caller.id, cwd: caller.header.cwd,
        }, exec.signal);
        exec.signal.throwIfAborted();
        const saved = await spillStore.saveText({
          owner: { sessionId: caller.id },
          source: { kind: 'tool', toolName: TOOL_NAME, callId: exec.callId, label: 'Conversation export' },
          suggestedName: result.filename,
          content: result.content,
        });
        exec.signal.throwIfAborted();
        return {
          sessionId: options.sessionId,
          filename: result.filename,
          mimeType: result.mimeType,
          locator: saved.locator,
          retrievalHint: saved.retrievalHint,
          temporary: true,
          bytes: saved.bytes,
          messageCount: result.messageCount,
          capturedThroughSeq: result.capturedThroughSeq,
          warnings: result.warnings,
        };
      } catch (error) {
        throw publicError(error, exec.signal);
      }
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Export conversation' }),
  };
}
