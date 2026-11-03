import { Buffer } from 'node:buffer';

export const DEFAULT_MAX_EXPORT_BYTES = 64 * 1024 * 1024;

/** Public errors are deliberately small: do not attach observations or provider errors. */
export class ExportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.status = status;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.length > 0;
// Unlike encodeURIComponent alone, this also handles a malformed logged UTF-16 id.
const encodedId = value => Array.from(value, character => /\p{Surrogate}/u.test(character)
  ? `%u${character.charCodeAt(0).toString(16).padStart(4, '0')}` : encodeURIComponent(character)).join('');
const invalid = message => new ExportError('INVALID_PARAMS', message, 400);
const corrupt = message => new ExportError('INVALID_OBSERVATION', message, 500);

/** Never coerce strings such as "false" to booleans, or accept authority fields. */
export function normalizeOptions(value) {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalid('导出参数必须是对象。');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !['sessionId', 'format', 'includeTools'].includes(key))) {
    throw invalid('包含不支持的导出参数。');
  }
  for (const key of keys) {
    if (!own(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      throw invalid('导出参数必须是普通数据。');
    }
  }
  // Backend identities are opaque, not paths; preserve their spelling exactly.
  // Download filename safety is handled independently by makeFilename.
  if (!own(value, 'sessionId') || typeof value.sessionId !== 'string'
      || value.sessionId.length > 512 || !value.sessionId.trim()
      || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value.sessionId)) {
    throw invalid('sessionId 必须是有效的会话标识。');
  }
  if (!own(value, 'format') || !['json', 'markdown'].includes(value.format)) {
    throw invalid('format 仅支持 json 或 markdown。');
  }
  if (own(value, 'includeTools') && typeof value.includeTools !== 'boolean') {
    throw invalid('includeTools 必须是布尔值。');
  }
  return {
    sessionId: value.sessionId,
    format: value.format,
    includeTools: own(value, 'includeTools') ? value.includeTools : false,
  };
}

function isoTime(value, error = corrupt) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw error('时间戳无效。');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw error('时间戳超出支持范围。');
  return date.toISOString();
}

function truncateUtf8(value, maximum) {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** A single basename; never a path, device name, header fragment, or split emoji. */
export function makeFilename(title, sessionId, format, now = Date.now()) {
  const stamp = isoTime(now, invalid).replace(/[-:.]/g, '');
  let stem = (typeof title === 'string' ? title : '').normalize('NFC').replace(/\p{Surrogate}/gu, '_')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/gu, ' ').replace(/^[. ]+|[. ]+$/g, '');
  if (!stem) stem = 'conversation';
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  stem = truncateUtf8(stem, 120).replace(/[. ]+$/g, '') || 'conversation';
  const shortId = truncateUtf8(String(sessionId).replace(/[^\p{L}\p{N}_-]/gu, '_'), 24) || 'session';
  return `${stem}_${stamp}_${shortId}.${format === 'markdown' ? 'md' : 'json'}`;
}

function warningCollector() {
  const warnings = [];
  const seen = new Set();
  return {
    warnings,
    add(code, message) {
      if (!seen.has(code)) {
        seen.add(code);
        warnings.push({ code, message });
      }
    },
  };
}

function unsupported(warnings) {
  warnings.add('UNSUPPORTED_CONTENT', '部分未知或格式无效的内容块已替换为安全占位符；未复制其原始数据。');
  return { type: 'unsupported', text: '[不支持的内容块，已省略]' };
}

function attachmentBlock(block, warnings) {
  const value = block.attachment;
  // In particular, never copy data URLs, filesystem paths, URLs, or binary payloads.
  if (!record(value) || typeof value.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.attachmentId)
      || !integer(value.bytes)) return unsupported(warnings);
  const attachment = { attachmentId: value.attachmentId, bytes: value.bytes };
  if (block.type === 'file') {
    if (typeof value.name !== 'string') return unsupported(warnings);
    attachment.name = value.name;
  } else {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
        || !integer(value.width) || !integer(value.height)) return unsupported(warnings);
    attachment.mediaType = value.mediaType;
    attachment.width = value.width;
    attachment.height = value.height;
    if (typeof value.name === 'string') attachment.name = value.name;
    if (record(value.originalDimensions) && integer(value.originalDimensions.width)
        && integer(value.originalDimensions.height)) {
      attachment.originalDimensions = {
        width: value.originalDimensions.width,
        height: value.originalDimensions.height,
      };
    }
  }
  warnings.add('ATTACHMENTS_NOT_PACKAGED', '附件仅保留引用元数据；图片和文件二进制内容未打包到此导出文件。');
  return { type: block.type, attachment };
}

function toolCallOf(value) {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.name)
      || typeof value.arguments !== 'string') return null;
  return { type: 'tool-call', id: value.id, name: value.name, arguments: value.arguments };
}

function parseQuestions(argumentsText) {
  let value;
  try { value = JSON.parse(argumentsText); } catch { return null; }
  if (!record(value) || !Array.isArray(value.questions) || value.questions.length === 0) return null;
  const questions = [];
  const ids = new Set();
  for (const q of value.questions) {
    if (!record(q) || typeof q.id !== 'string' || typeof q.question !== 'string' || ids.has(q.id)
        || (own(q, 'header') && typeof q.header !== 'string')
        || (own(q, 'multi_select') && typeof q.multi_select !== 'boolean')
        || (own(q, 'options') && !Array.isArray(q.options))) return null;
    ids.add(q.id);
    const question = { id: q.id, text: q.question };
    if (own(q, 'header')) question.header = q.header;
    if (own(q, 'multi_select')) question.multiSelect = q.multi_select;
    if (own(q, 'options')) {
      question.options = [];
      for (const option of q.options) {
        if (!record(option) || typeof option.label !== 'string'
            || (own(option, 'description') && typeof option.description !== 'string')) return null;
        question.options.push({
          label: option.label,
          ...(own(option, 'description') ? { description: option.description } : {}),
        });
      }
    }
    questions.push(question);
  }
  return questions;
}

function parseAnswers(content) {
  if (!Array.isArray(content)) return null;
  const text = content.find(block => record(block) && block.type === 'text');
  if (!text || typeof text.text !== 'string') return null;
  let value;
  try { value = JSON.parse(text.text); } catch { return null; }
  if (!record(value) || !Array.isArray(value.answers)) return null;
  if (!value.answers.every(answer => record(answer) && typeof answer.id === 'string'
      && Array.isArray(answer.selected) && answer.selected.every(item => typeof item === 'string')
      && (!own(answer, 'custom') || typeof answer.custom === 'string'))) return null;
  return value.answers;
}

function pendingAnswer(content) {
  const first = Array.isArray(content) && content.find(block => record(block) && block.type === 'text');
  if (!first || typeof first.text !== 'string') return false;
  try { return JSON.parse(first.text)?.pending === true; } catch { return false; }
}

function messageOf(event) {
  if (event.type === 'user/message') return event.data;
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data?.message;
  return null;
}

function messageBase(event, role, id) {
  return {
    id: nonempty(id) ? id : `event:${role}:${event.seq}`,
    seq: event.seq,
    time: isoTime(event.time),
    role,
    content: [],
  };
}

function collectCalls(events, warnings) {
  const calls = new Map();
  function add(block, event, blockIndex, origin) {
    const call = toolCallOf(block);
    if (!call) return;
    const old = calls.get(call.id);
    if (old) {
      if (old.call.name !== call.name || old.call.arguments !== call.arguments) {
        old.ambiguous = true;
        warnings.add('AMBIGUOUS_TOOL_CALL', '发现同一调用标识对应不同工具请求；未将其推断为用户问答。');
      }
      // The original assistant block wins over a repeated tool/call bookkeeping event.
      if (old.origin === 'log' && origin === 'assistant') {
        calls.set(call.id, { call, event, blockIndex, origin, ambiguous: old.ambiguous });
      }
    } else calls.set(call.id, { call, event, blockIndex, origin, ambiguous: false });
  }
  for (const event of events) {
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      const content = messageOf(event)?.content;
      if (Array.isArray(content)) content.forEach((block, index) => {
        if (record(block) && block.type === 'tool-call') add(block, event, index, 'assistant');
      });
    } else if (event.type === 'tool/call' && record(event.data)) {
      add({ id: event.data.callId, name: event.data.name, arguments: event.data.arguments }, event, 0, 'log');
    }
  }
  for (const entry of calls.values()) {
    if (entry.call.name === 'ask_user_question' && !entry.ambiguous) {
      entry.questions = parseQuestions(entry.call.arguments);
      if (!entry.questions) warnings.add('UNREADABLE_QUESTION', '部分提问参数无法安全解析，未推断其问答内容。');
    }
  }
  return calls;
}

function normalizeTranscript(observation, options, exportedAt) {
  if (!record(observation) || !record(observation.header) || !Array.isArray(observation.events)
      || !Number.isSafeInteger(observation.cursor) || observation.cursor < -1
      || !integer(observation.inheritedEventCount)) throw corrupt('会话快照格式无效。');
  const { header } = observation;
  if (header.id !== options.sessionId) throw corrupt('会话快照标识不匹配。');
  const session = { id: header.id, title: 'conversation', createdAt: isoTime(header.createdAt) };
  if (nonempty(header.parentSession)) session.parentSessionId = header.parentSession;
  const warnings = warningCollector();
  if (observation.source === 'live') {
    warnings.add('LIVE_SNAPSHOT', '这是已提交会话事件的即时快照；不包含未提交的流式内容、生成尝试或之后产生的消息。');
  }
  const events = observation.events.map((event, index) => {
    if (!record(event) || !integer(event.seq)) throw corrupt('会话事件序号无效。');
    return { event, index };
  }).filter(({ event }) => event.seq <= observation.cursor)
    .sort((a, b) => a.event.seq - b.event.seq || a.index - b.index).map(item => item.event);
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      session.title = event.data.title.trim() ? event.data.title : 'conversation';
    }
  }
  const calls = collectCalls(events, warnings);
  const messages = [];
  const settled = new Map();

  function emitQuestions(entry) {
    entry.questions.forEach((q, index) => {
      const result = messageBase(entry.event, 'assistant', `qa:assistant:${encodedId(entry.call.id)}:${index}`);
      result.content = [{ type: 'text', text: q.text }];
      result.questionId = q.id;
      if (own(q, 'header')) result.questionHeader = q.header;
      if (own(q, 'options')) result.questionOptions = q.options;
      if (own(q, 'multiSelect')) result.multiSelect = q.multiSelect;
      if (entry.event.data?.interrupted === true) result.interrupted = true;
      messages.push(result);
    });
  }

  function emitAnswers(event, callId, content) {
    const entry = calls.get(callId);
    if (!entry?.questions || entry.event.seq > event.seq) return false;
    const answers = parseAnswers(content);
    if (!answers) return false;
    let answered = settled.get(callId);
    if (!answered) { answered = new Set(); settled.set(callId, answered); }
    for (const answer of answers) {
      const index = entry.questions.findIndex(question => question.id === answer.id);
      if (index < 0) {
        warnings.add('UNMATCHED_QUESTION_ANSWER', '部分问题回答无法与同一调用中的问题标识对应，已省略。');
        continue;
      }
      if (answered.has(answer.id)) continue;
      answered.add(answer.id);
      const result = messageBase(event, 'user', `qa:user:${encodedId(callId)}:${index}`);
      result.questionId = answer.id;
      result.content = answer.selected.map(text => ({ type: 'text', text }));
      if (own(answer, 'custom')) result.content.push({ type: 'text', text: answer.custom });
      if (!result.content.length) result.content.push({ type: 'text', text: '' });
      messages.push(result);
    }
    return true;
  }

  for (const event of events) {
    if (event.type === 'tool/call') {
      const entry = calls.get(event.data?.callId);
      if (!entry || entry.event !== event || entry.origin !== 'log') continue;
      if (entry.questions) emitQuestions(entry);
      else if (options.includeTools) {
        const result = messageBase(event, 'assistant', `tool-call:${encodedId(entry.call.id)}:${event.seq}`);
        result.content = [entry.call];
        messages.push(result);
      }
      continue;
    }
    if (event.surfaceOp !== 'append') continue;
    const message = messageOf(event);
    if (!record(message)) continue;
    let role;
    if (event.type === 'user/message') {
      if (message.source?.kind === 'user-question-reply') {
        if (!emitAnswers(event, message.source.callId, message.content)) {
          warnings.add('UNMATCHED_QUESTION_ANSWER', '部分问题回答无法与同一调用中的问题标识对应，已省略。');
        }
        continue;
      }
      if (message.source?.kind !== 'user') continue;
      role = 'user';
    } else if (event.type === 'assistant/message') role = 'assistant';
    else if (event.type === 'tool/result') {
      const entry = calls.get(message.toolCallId);
      if (entry?.questions && entry.event.seq <= event.seq && event.data.error === undefined && message.isError !== true) {
        if (emitAnswers(event, message.toolCallId, message.content) || pendingAnswer(message.content)) continue;
        warnings.add('UNREADABLE_ANSWER', '部分提问结果无法安全解析，未将其推断为用户回答。');
      }
      if (!options.includeTools) continue;
      role = 'tool';
    } else continue;

    const result = messageBase(event, role, message.id);
    if (role === 'assistant' && event.data.interrupted === true) result.interrupted = true;
    if (role === 'tool') {
      if (nonempty(message.toolCallId)) result.toolCallId = message.toolCallId;
      // SessionEventMap records canonical failures on data.error, independently
      // of the optional message flag. Export only the boolean, never raw errors.
      const recordedError = record(event.data.error)
        && typeof event.data.error.name === 'string' && typeof event.data.error.code === 'string';
      if (recordedError) result.isError = true;
      else if (typeof message.isError === 'boolean') result.isError = message.isError;
    }
    const deferredQuestions = [];
    const content = Array.isArray(message.content) ? message.content : [null];
    content.forEach((block, index) => {
      if (!record(block)) { result.content.push(unsupported(warnings)); return; }
      switch (block.type) {
        case 'reasoning':
        case 'tool-addition':
        case 'tool-removal':
          return;
        case 'text':
          result.content.push(typeof block.text === 'string' ? { type: 'text', text: block.text } : unsupported(warnings));
          return;
        case 'image':
        case 'file':
          result.content.push(attachmentBlock(block, warnings));
          return;
        case 'tool-call': {
          // Only assistant tool-call blocks are a verified source of invocations.
          if (role !== 'assistant') return;
          const entry = calls.get(block.id);
          if (!entry) { if (options.includeTools) result.content.push(unsupported(warnings)); return; }
          if (entry.event !== event || entry.blockIndex !== index || entry.origin !== 'assistant') return;
          if (entry.questions) deferredQuestions.push(entry);
          else if (options.includeTools) result.content.push(entry.call);
          return;
        }
        default: result.content.push(unsupported(warnings));
      }
    });
    if (result.content.length) messages.push(result);
    deferredQuestions.forEach(emitQuestions);
  }
  return {
    schemaVersion: 1,
    exportedAt,
    session,
    snapshot: {
      throughSeq: observation.cursor === -1 ? null : observation.cursor,
      includeTools: options.includeTools,
      inheritedEventCount: observation.inheritedEventCount,
    },
    messages,
    warnings: warnings.warnings,
  };
}

function boundedWriter(maximum) {
  const parts = [];
  let bytes = 0;
  return {
    append(text) {
      const next = Buffer.byteLength(text, 'utf8');
      if (next > maximum - bytes) {
        throw new ExportError('EXPORT_TOO_LARGE', `导出内容超过 ${maximum} 字节限制；未截断或生成部分文件。`, 413);
      }
      parts.push(text);
      bytes += next;
    },
    finish() { return { content: parts.join(''), bytes }; },
  };
}

// Incremental JSON escaping bounds intermediate allocations even for a huge text block.
// Its output is exactly JSON.stringify(value, null, 2), followed by one newline.
function writeJson(value, writer, depth = 0) {
  const append = text => writer.append(text);
  if (typeof value === 'string') {
    append('"');
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 8192, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end -= 1;
      append(JSON.stringify(value.slice(start, end)).slice(1, -1));
      start = end;
    }
    append('"');
  } else if (Array.isArray(value)) {
    append('[');
    value.forEach((item, index) => {
      append(`${index ? ',' : ''}\n${'  '.repeat(depth + 1)}`);
      writeJson(item, writer, depth + 1);
    });
    if (value.length) append(`\n${'  '.repeat(depth)}`);
    append(']');
  } else if (record(value)) {
    append('{');
    const entries = Object.entries(value);
    entries.forEach(([key, item], index) => {
      append(`${index ? ',' : ''}\n${'  '.repeat(depth + 1)}${JSON.stringify(key)}: `);
      writeJson(item, writer, depth + 1);
    });
    if (entries.length) append(`\n${'  '.repeat(depth)}`);
    append('}');
  } else append(JSON.stringify(value));
}

/** Escape generated metadata only. User/assistant text is intentionally not rewritten. */
export function escapeMarkdownMetadata(value) {
  return String(value).replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~$-]/g, '\\$&');
}

function writeFence(text, language, writer) {
  let longest = 0;
  let run = 0;
  for (const character of text) {
    run = character === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  writer.append(`${fence}${language}\n`);
  writer.append(text);
  if (!text.endsWith('\n')) writer.append('\n');
  writer.append(`${fence}\n`);
}

function writeMarkdown(document, writer) {
  const meta = escapeMarkdownMetadata;
  const append = text => writer.append(text);
  append('# 对话导出\n\n## 会话信息\n\n');
  append(`- 标题：${meta(document.session.title)}\n- 会话 ID：${meta(document.session.id)}\n`);
  append(`- 创建时间：${meta(document.session.createdAt)}\n- 导出时间：${meta(document.exportedAt)}\n`);
  if (document.session.parentSessionId) append(`- 父会话 ID：${meta(document.session.parentSessionId)}\n`);
  append(`- 截至事件序号：${document.snapshot.throughSeq ?? '无'}\n- 包含工具：${document.snapshot.includeTools ? '是' : '否'}\n`);
  append(`- 继承事件数：${document.snapshot.inheritedEventCount}\n\n## 对话\n\n`);
  if (!document.messages.length) append('（此快照没有可导出的对话消息。）\n');
  for (const message of document.messages) {
    append(`### ${{ user: '用户', assistant: '助手', tool: '工具' }[message.role]} · 事件 ${message.seq}\n\n`);
    append(`- 时间：${meta(message.time)}\n- 消息 ID：${meta(message.id)}\n`);
    if (message.interrupted) append('- 状态：已中断（仅包含已记录正文）\n');
    if (own(message, 'toolCallId')) append(`- 工具调用 ID：${meta(message.toolCallId)}\n`);
    if (own(message, 'isError')) append(`- 工具错误：${message.isError ? '是' : '否'}\n`);
    if (own(message, 'questionId')) append(`- 问题 ID：${meta(message.questionId)}\n`);
    if (own(message, 'questionHeader')) append(`- 问题标题：${meta(message.questionHeader)}\n`);
    if (own(message, 'multiSelect')) append(`- 多选：${message.multiSelect ? '是' : '否'}\n`);
    append('\n');
    for (const block of message.content) {
      if (block.type === 'text') {
        if (message.role === 'tool') writeFence(block.text, 'text', writer);
        else append(block.text);
      } else if (block.type === 'tool-call') {
        append(`**工具调用：${meta(block.name)}**\n\n- 调用 ID：${meta(block.id)}\n\n`);
        writeFence(block.arguments, 'json', writer);
      } else if (block.type === 'image' || block.type === 'file') {
        const item = block.attachment;
        append(`> 附件（${block.type === 'image' ? '图片' : '文件'}）：${meta(item.name ?? '未命名')}\n`);
        append(`> 引用 ID：${meta(item.attachmentId)}\n> 大小：${item.bytes} 字节\n`);
        if (block.type === 'image') append(`> 类型：${meta(item.mediaType)}；尺寸：${item.width} × ${item.height}\n`);
        append('> 仅引用元数据；二进制内容未打包。');
      } else append(block.text);
      append('\n\n');
    }
    if (message.questionOptions?.length) {
      append('**选项**\n\n');
      for (const option of message.questionOptions) {
        append(`- ${meta(option.label)}${own(option, 'description') ? `：${meta(option.description)}` : ''}\n`);
      }
      append('\n');
    }
  }
  if (document.warnings.length) {
    append('## 导出说明\n\n');
    for (const warning of document.warnings) append(`- ${meta(warning.message)}\n`);
  }
}

/** Serialize one observed prefix. This function does no I/O and never evaluates message content. */
export function createExport(observation, value, { maxExportBytes = DEFAULT_MAX_EXPORT_BYTES, now = Date.now() } = {}) {
  const options = normalizeOptions(value);
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes <= 0) throw invalid('导出大小限制必须是正整数。');
  const exportedAt = isoTime(now, invalid);
  const document = normalizeTranscript(observation, options, exportedAt);
  const writer = boundedWriter(maxExportBytes);
  if (options.format === 'json') {
    writeJson(document, writer);
    writer.append('\n');
  } else writeMarkdown(document, writer);
  return {
    filename: makeFilename(document.session.title, options.sessionId, options.format, now),
    mimeType: options.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    ...writer.finish(),
    messageCount: document.messages.length,
    capturedThroughSeq: document.snapshot.throughSeq,
    warnings: document.warnings,
  };
}
