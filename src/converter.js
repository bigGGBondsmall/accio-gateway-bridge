'use strict';

/**
 * converter.js
 *
 * Bidirectional translation between the Accio/GenAI ("Proto") request and
 * response shapes and OpenAI-compatible (chat completions) / Ollama (api/chat)
 * shapes.
 *
 * Accio request (abridged):
 *   { model, contents: [{ role, parts: [{ text | functionCall | functionResponse }] }],
 *     systemInstruction, tools, temperature, maxOutputTokens }
 *
 * OpenAI request produced here:
 *   { model, messages: [{ role: 'system'|'user'|'assistant'|'tool', ... }],
 *     tools, temperature, max_tokens, stream: true }
 *
 * Everything is defensive: Accio reuses several camelCase/snake_case aliases and
 * sometimes nests the generation knobs inside `generationConfig`.
 */

const MAX_TEMPERATURE = 2;
const DEFAULT_CONTEXT_WINDOW = 128000;
/**
 * Fallback schema for a declaration whose parameters could not be resolved.
 *
 * `additionalProperties: true` matters: an empty `properties` without it reads as
 * "this tool takes no arguments", so a model handed that schema cannot call a tool
 * that needs inputs at all and silently gives up on it.
 */
const DEFAULT_TOOL_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/*
 * Accio's ADK transport serialises the proto fields as snake_case
 * (`function_call` / `function_response`, inner `args_json` / `response_json`) while
 * its in-process code paths use camelCase. These accessors accept both: reading only
 * camelCase silently dropped every tool call and every tool result, so the model
 * never saw its own calls succeed and re-issued them indefinitely.
 */
function functionCallOf(part) {
  if (!isObject(part)) return undefined;
  return firstDefined(part.functionCall, part.function_call);
}

function functionResponseOf(part) {
  if (!isObject(part)) return undefined;
  return firstDefined(part.functionResponse, part.function_response);
}

/** Parse a JSON-string field; a non-string or unparsable value yields undefined. */
function parseJsonField(value) {
  return typeof value === 'string' ? safeJsonParse(value, undefined) : undefined;
}

/**
 * Unwrap Accio's tool-result envelope.
 *
 * `response_json` is `{"result":"..."}` (sometimes with `is_error`/`content`), so the
 * model should receive the tool's own text rather than a JSON wrapper.
 */
function unwrapToolResult(value) {
  if (!isObject(value)) return value;
  if (value.__raw !== undefined) return value.__raw;
  const keys = Object.keys(value);
  const wrapperKeys = new Set(['result', 'content', 'is_error', 'isError']);
  if (keys.length > 0 && keys.every((key) => wrapperKeys.has(key))) {
    return firstDefined(value.result, value.content, value);
  }
  return value;
}

/** Join a base URL with a path, tolerating trailing/leading slashes. */
function resolveEndpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(suffix || '').replace(/^\/+/, '');
  return path ? `${base}/${path}` : base;
}

/**
 * Collect text from a `parts` array (strings or `{ text }` objects).
 *
 * `thought: true` parts carry the model's internal reasoning trace. Accio
 * replays every previously seen trace back to us on the next turn
 * (see `assistantMessageToProtoContent` -> `{ text, thought: true }`), but a
 * trace is not assistant output. Folding it into `content` makes the model read
 * its own narration as prior replies and echo it ("I need to actually make the
 * tool call...") instead of executing the tool, so it is dropped here.
 */
function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  const chunks = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    if (part.thought === true) continue;
    const text = firstDefined(part.text, part.textDelta);
    if (typeof text === 'string') chunks.push(text);
  }
  return chunks.join('\n');
}

function normalizeParts(entry) {
  if (!isObject(entry)) return [];
  if (Array.isArray(entry.parts)) return entry.parts;
  if (typeof entry.text === 'string') return [{ text: entry.text }];
  return [];
}

/** systemInstruction may be a string, `{ parts }` or `{ text }`. */
function extractSystemInstruction(body) {
  const raw = firstDefined(
    body.systemInstruction,
    body.system_instruction,
    body.system_instructions,
    body.system,
  );
  if (raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return textFromParts(raw);
  if (isObject(raw)) {
    if (typeof raw.text === 'string' && !Array.isArray(raw.parts)) return raw.text;
    return textFromParts(raw.parts);
  }
  return '';
}

/** Flatten GenAI tool declarations into OpenAI `tools[]`. */
function toOpenAITools(body) {
  // Diagnostics travel on the returned array (arrays survive JSON.stringify without
  // their extra properties) so callers can report dropped or unusable declarations
  // instead of silently shipping a model a tool it cannot call.
  const diagnostics = { count: 0, dropped: [], schemaFallbacks: [], upgraded: [] };
  const tools = [];
  const indexByName = new Map();

  const addDeclaration = (decl) => {
    if (!isObject(decl)) return;
    const name = firstDefined(decl.name, decl.functionName, decl.function_name, decl.id);
    if (!isNonEmptyString(name)) {
      const shape = Object.keys(decl).slice(0, 6).join('|');
      diagnostics.dropped.push(shape || 'object');
      return;
    }

    const parameters = resolveToolSchema(decl);
    const description = typeof decl.description === 'string' ? decl.description : '';

    const existing = indexByName.get(name);
    if (existing !== undefined) {
      // A name can arrive twice: a placeholder first, the real declaration later.
      // Keeping the first one used to leave the model a schema-less tool.
      const current = tools[existing].function;
      if (current.parameters === DEFAULT_TOOL_SCHEMA && parameters) {
        current.parameters = parameters;
        if (!current.description && description) current.description = description;
        diagnostics.upgraded.push(name);
      }
      return;
    }

    if (!parameters) diagnostics.schemaFallbacks.push(name);
    indexByName.set(name, tools.length);
    tools.push({
      type: 'function',
      function: {
        name,
        description,
        parameters: parameters || DEFAULT_TOOL_SCHEMA,
      },
    });
  };

  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    for (const key of ['functionDeclarations', 'functions', 'declarations', 'tools']) {
      if (Array.isArray(node[key])) {
        node[key].forEach(visit);
        return;
      }
    }
    if (isObject(node.function)) {
      addDeclaration(node.function);
      return;
    }
    addDeclaration(node);
  };

  visit(body.tools);
  visit(body.functionDeclarations);

  diagnostics.count = tools.length;
  tools.diagnostics = diagnostics;
  return tools;
}

/**
 * Resolve a tool's JSON schema.
 *
 * Accio 0.37 sends `{ name, description, parameters_json }` — the schema is a JSON
 * string under a snake_case key, and that is the only shape it uses. Providers
 * disagree on both the key name and the encoding, so every known variant is
 * accepted. Missing them used to fall back to a no-argument schema, which made the
 * tool uncallable and sent the agent into a loop of retrying whatever it could.
 */
function resolveToolSchema(decl) {
  const raw = firstDefined(
    decl.parameters,
    decl.parameters_json,
    decl.parametersJson,
    decl.parametersJSON,
    decl.parametersJsonSchema,
    decl.parameters_json_schema,
    decl.parametersSchema,
    decl.input_schema,
    decl.inputSchema,
    decl.input_json,
    decl.args,
  );
  if (isObject(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = safeJsonParse(raw, undefined);
    if (isObject(parsed) && parsed.__raw === undefined) return parsed;
  }
  return undefined;
}

/**
 * Build an OpenAI `content` value from GenAI parts.
 *
 * Text-only turns stay a plain string for maximum compatibility with
 * OpenAI-compatible servers. Attachments switch to the array form:
 * `inlineData` images become `image_url` data URLs, and `fileData` becomes a text
 * note carrying the name/mime/URI (the chat-completions API has no portable way
 * to inline an arbitrary file URI). Returns null when the turn carries nothing, so
 * callers can drop it instead of emitting an empty message.
 */
function contentFromParts(parts) {
  if (!Array.isArray(parts)) return null;
  const out = [];
  let hasMedia = false;

  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) out.push({ type: 'text', text: part });
      continue;
    }
    if (!isObject(part)) continue;
    if (part.thought === true) continue;

    const text = firstDefined(part.text, part.textDelta);
    if (typeof text === 'string' && text) out.push({ type: 'text', text });

    const inline = firstDefined(part.inlineData, part.inline_data);
    if (isObject(inline) && typeof inline.data === 'string' && inline.data) {
      const mime = isNonEmptyString(inline.mimeType) ? inline.mimeType : 'image/png';
      if (/^image\//i.test(mime)) {
        out.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${inline.data}` } });
        hasMedia = true;
      } else {
        out.push({ type: 'text', text: `[attachment: ${mime}, ${inline.data.length} base64 chars]` });
      }
    }

    const file = firstDefined(part.fileData, part.file_data);
    if (isObject(file) && isNonEmptyString(file.fileUri)) {
      const name = file.fileUri.split('/').pop() || file.fileUri;
      const mime = isNonEmptyString(file.mimeType) ? file.mimeType : 'application/octet-stream';
      out.push({ type: 'text', text: `[attachment: ${name} (${mime}) at ${file.fileUri}]` });
    }
  }

  if (out.length === 0) return null;
  if (hasMedia) return out;
  const joined = out.map((p) => p.text).join('\n');
  return joined || null;
}

/** GenAI `contents` -> OpenAI `messages`. */
function toOpenAIMessages(body) {
  const messages = [];
  const system = extractSystemInstruction(body);
  if (system.trim()) messages.push({ role: 'system', content: system });

  const contents = Array.isArray(body.contents) ? body.contents : [];
  let callSeq = 0;

  for (const entry of contents) {
    if (!isObject(entry)) continue;
    const role = String(firstDefined(entry.role, 'user')).toLowerCase();
    const parts = normalizeParts(entry);
    const text = textFromParts(parts);

    const functionResponses = parts.filter((part) => isObject(functionResponseOf(part)));
    const functionCalls = parts.filter((part) => isObject(functionCallOf(part)));

    if (functionResponses.length > 0) {
      for (const part of functionResponses) {
        const response = functionResponseOf(part);
        const name = firstDefined(response.name, response.id, 'tool');
        const rawPayload = firstDefined(
          response.response,
          response.result,
          parseJsonField(response.responseJson),
          parseJsonField(response.response_json),
          {},
        );
        const payload = unwrapToolResult(rawPayload);
        messages.push({
          role: 'tool',
          tool_call_id: String(
            firstDefined(
              response.id,
              response.callId,
              response.call_id,
              response.toolCallId,
              response.tool_call_id,
              `call_${name}_${callSeq++}`,
            ),
          ),
          name: typeof name === 'string' ? name : undefined,
          content: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
        });
      }
      if (text.trim()) messages.push({ role: 'user', content: text });
      continue;
    }

    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((part) => {
        const call = functionCallOf(part);
        const rawArgs = firstDefined(
          call.args,
          call.arguments,
          parseJsonField(call.argsJson),
          parseJsonField(call.args_json),
          {},
        );
        // Replayed calls with unparsable args must not smuggle `{ __raw }` upstream:
        // `arguments` has to be valid JSON, so fall back to an empty object.
        const args = isObject(rawArgs) && rawArgs.__raw ? {} : rawArgs;
        return {
          id: String(firstDefined(call.id, call.callId, call.call_id, `call_${callSeq++}`)),
          type: 'function',
          function: {
            name: String(firstDefined(call.name, call.functionName, call.function_name, 'tool')),
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      });
      messages.push({ role: 'assistant', content: text.trim() ? text : null, tool_calls: toolCalls });
      continue;
    }

    if (role === 'model' || role === 'assistant') {
      const content = contentFromParts(parts);
      // A turn whose parts were all reasoning (or empty) carries nothing to replay.
      if (content !== null) messages.push({ role: 'assistant', content });
      continue;
    }
    if (role === 'tool' || role === 'function') {
      messages.push({ role: 'tool', tool_call_id: `call_${role}_${callSeq++}`, content: text });
      continue;
    }
    const userContent = contentFromParts(parts);
    if (userContent !== null) messages.push({ role: 'user', content: userContent });
  }

  return messages;
}

function readGenerationOptions(body) {
  const cfg = isObject(body.generationConfig)
    ? body.generationConfig
    : isObject(body.generation_config)
      ? body.generation_config
      : {};

  const temperatureRaw = firstDefined(body.temperature, cfg.temperature);
  const maxTokensRaw = firstDefined(
    body.maxOutputTokens,
    body.max_output_tokens,
    body.maxTokens,
    cfg.maxOutputTokens,
    cfg.max_output_tokens,
    cfg.maxTokens,
  );
  const topPRaw = firstDefined(body.topP, body.top_p, cfg.topP, cfg.top_p);
  const topKRaw = firstDefined(body.topK, body.top_k, cfg.topK, cfg.top_k);
  const stopRaw = firstDefined(body.stopSequences, body.stop_sequences, body.stop, cfg.stopSequences, cfg.stop_sequences);

  const options = {};
  if (temperatureRaw !== undefined && Number.isFinite(Number(temperatureRaw))) {
    options.temperature = Math.min(Math.max(Number(temperatureRaw), 0), MAX_TEMPERATURE);
  }
  if (maxTokensRaw !== undefined && Number(maxTokensRaw) > 0) {
    options.maxTokens = Math.floor(Number(maxTokensRaw));
  }
  if (topPRaw !== undefined && Number.isFinite(Number(topPRaw))) {
    options.topP = Number(topPRaw);
  }
  if (topKRaw !== undefined && Number.isFinite(Number(topKRaw))) {
    options.topK = Number(topKRaw);
  }
  if (stopRaw !== undefined) {
    const stops = (Array.isArray(stopRaw) ? stopRaw : [stopRaw]).filter(isNonEmptyString);
    if (stops.length > 0) options.stop = stops;
  }
  // Accio's thinking controls. `reasoningEffort` / `properties.reasoning_effort`
  // choose how hard the model thinks; `thinkingBudget` / `includeThoughts` decide
  // whether the trace is produced and surfaced at all.
  const properties = isObject(body.properties) ? body.properties : {};
  const effortRaw = firstDefined(
    body.reasoningEffort,
    body.reasoning_effort,
    properties.reasoning_effort,
    properties.reasoningEffort,
    cfg.reasoningEffort,
    cfg.reasoning_effort,
  );
  if (isNonEmptyString(effortRaw)) options.reasoningEffort = String(effortRaw);

  const thinkingBudgetRaw = firstDefined(body.thinkingBudget, body.thinking_budget, cfg.thinkingBudget, cfg.thinking_budget);
  if (Number.isFinite(Number(thinkingBudgetRaw))) options.thinkingBudget = Number(thinkingBudgetRaw);

  const includeThoughtsRaw = firstDefined(body.includeThoughts, body.include_thoughts, cfg.includeThoughts, cfg.include_thoughts);
  if (typeof includeThoughtsRaw === 'boolean') options.includeThoughts = includeThoughtsRaw;

  const responseFormatRaw = firstDefined(body.responseFormat, body.response_format, cfg.responseFormat, cfg.response_format);
  if (isNonEmptyString(responseFormatRaw)) options.responseFormat = String(responseFormatRaw);

  const toolChoiceRaw = firstDefined(body.toolChoice, body.tool_choice, cfg.toolChoice, cfg.tool_choice);
  if (isNonEmptyString(toolChoiceRaw)) options.toolChoice = String(toolChoiceRaw);

  return options;
}

/** Resolve the model name to send upstream. */
function resolveUpstreamModel(modelConfig, body) {
  return firstDefined(
    modelConfig.upstreamModel,
    modelConfig.modelCode,
    modelConfig.id,
    body.model,
  );
}

/** Accio sends `responseFormat` as a plain string; OpenAI expects `{ type }`. */
function normalizeResponseFormat(value) {
  const type = String(value || '').toLowerCase();
  if (type === 'json_object' || type === 'json_schema' || type === 'text') return { type };
  return undefined;
}

/**
 * Accio GenAI request -> OpenAI chat-completions payload.
 * `stream` defaults to true, which is what Accio expects.
 */
function toOpenAIRequest(modelConfig, body) {
  const options = readGenerationOptions(body);
  const tools = toOpenAITools(body);
  const payload = {
    model: resolveUpstreamModel(modelConfig, body),
    messages: toOpenAIMessages(body),
    stream: body.stream !== undefined ? body.stream !== false : (modelConfig.stream !== false),
  };

  if (payload.stream && (modelConfig.provider || 'openai') === 'openai') {
    payload.stream_options = { include_usage: true };
  }
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
  if (options.topP !== undefined) payload.top_p = options.topP;
  if (options.stop) payload.stop = options.stop;
  if (options.topK !== undefined) payload.top_k = options.topK;
  if (options.reasoningEffort !== undefined) payload.reasoning_effort = options.reasoningEffort;
  if (options.responseFormat !== undefined) payload.response_format = normalizeResponseFormat(options.responseFormat);
  if (tools.length > 0 && options.toolChoice !== undefined) payload.tool_choice = options.toolChoice;
  if (tools.length > 0) payload.tools = tools;

  return payload;
}

/**
 * Accio GenAI request -> Ollama `/api/chat` payload.
 * Ollama speaks its own dialect: `options.num_predict`, tool calls without ids.
 */
function toOllamaRequest(modelConfig, body) {
  const options = readGenerationOptions(body);
  const messages = toOpenAIMessages(body).map((message) => {
    const copy = { role: message.role, content: message.content ?? '' };
    if (message.tool_calls) {
      copy.tool_calls = message.tool_calls.map((call) => ({
        function: { name: call.function.name, arguments: safeJsonParse(call.function.arguments, {}) },
      }));
    }
    return copy;
  });

  const payload = {
    model: resolveUpstreamModel(modelConfig, body),
    messages,
    stream: body.stream !== undefined ? body.stream !== false : (modelConfig.stream !== false),
  };

  const ollamaOptions = {};
  if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature;
  if (options.maxTokens !== undefined) ollamaOptions.num_predict = options.maxTokens;
  if (options.topP !== undefined) ollamaOptions.top_p = options.topP;
  if (options.topK !== undefined) ollamaOptions.top_k = options.topK;
  if (options.stop) ollamaOptions.stop = options.stop;
  if (Object.keys(ollamaOptions).length > 0) payload.options = ollamaOptions;

  const tools = toOpenAITools(body);
  if (tools.length > 0) {
    payload.tools = tools.map((tool) => ({
      type: 'function',
      function: tool.function,
    }));
  }

  return payload;
}

/**
 * Streaming chunk -> Accio SSE frame carrying text.
 *
 * With `{ thought: true }` the text is emitted as a reasoning part. Accio routes
 * such parts into `metadata.reasoning` (its "thinking" UI) instead of the visible
 * message body, so the trace never pollutes the transcript the model reads back.
 */
function textFrame(text, options) {
  const part = { text };
  if (options && options.thought === true) part.thought = true;
  return {
    content: { role: 'model', parts: [part] },
    turnComplete: false,
  };
}
/**
 * Streaming tool-call turn -> single Accio SSE frame.
 *
 * Accio's parser JSON.parses `argsJson` and, on failure, keeps `arguments = {}` and
 * sets `argumentsParseError`. So when the model emits malformed arguments we pass the
 * raw text through untouched (accidentally wrapping it in `{ __raw }` handed the tool
 * a bogus parameter instead of surfacing a parse error).
 */
function toolCallsFrame(calls) {
  return {
    content: {
      role: 'model',
      parts: calls.map((call) => {
        const { args, argsJson } = resolveToolCallArgs(call);
        return {
          functionCall: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            args,
            argsJson,
          },
        };
      }),
    },
    turnComplete: true,
    finishReason: 'TOOL_CALLS',
  };
}

/** Normalise an upstream tool call into `{ args, argsJson }` for Accio. */
function resolveToolCallArgs(call) {
  if (isObject(call.args)) {
    return { args: call.args, argsJson: JSON.stringify(call.args) };
  }
  const text = typeof call.args === 'string' ? call.args.trim() : '';
  if (!text) return { args: {}, argsJson: '{}' };
  try {
    const parsed = JSON.parse(text);
    if (isObject(parsed)) return { args: parsed, argsJson: JSON.stringify(parsed) };
  } catch {
    /* fall through: hand Accio the raw text so it can flag argumentsParseError */
  }
  return { args: {}, argsJson: text };
}

/** Terminal Accio SSE frame. */
function doneFrame(usage, finishReason) {
  const frame = {
    content: { role: 'model', parts: [] },
    turnComplete: true,
    finishReason: mapFinishReason(finishReason),
  };
  if (usage) frame.usageMetadata = toUsageMetadata(usage);
  return frame;
}

function toUsageMetadata(usage) {
  if (!isObject(usage)) return undefined;
  const prompt = num(usage.prompt_tokens ?? usage.promptTokenCount);
  const candidates = num(usage.completion_tokens ?? usage.candidatesTokenCount);
  const total = num(usage.total_tokens ?? usage.totalTokenCount) ?? (prompt ?? 0) + (candidates ?? 0);
  const metadata = {};
  if (prompt !== undefined) metadata.promptTokenCount = prompt;
  if (candidates !== undefined) metadata.candidatesTokenCount = candidates;
  if (total !== undefined) metadata.totalTokenCount = total;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Map provider finish reasons onto Accio finish reasons. */
function mapFinishReason(reason) {
  switch (String(reason || '').toLowerCase()) {
    case 'length':
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'tool_calls':
    case 'tool_use':
      return 'TOOL_CALLS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

function safeJsonParse(text, fallback) {
  if (isObject(text)) return text;
  if (typeof text !== 'string' || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

function parseToolArguments(text) {
  return safeJsonParse(text, {});
}

/** Non-streaming GenAI response -> OpenAI chat completion object. */
function genAIResponseToOpenAI(body, modelName) {
  const parts = normalizeParts({
    parts: Array.isArray(body.parts) ? body.parts : (body.content && body.content.parts),
  });
  const text = textFromParts(parts);
  const calls = parts.filter((part) => isObject(part) && isObject(part.functionCall));
  const message = { role: 'assistant', content: text || null };
  if (calls.length > 0) {
    message.tool_calls = calls.map((part, index) => ({
      id: `call_${index}`,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    }));
  }
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName || body.model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
  };
}

/** Non-streaming OpenAI chat completion -> GenAI response object. */
function openAIResponseToGenAI(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined;
  const message = choice?.message ?? {};
  const parts = [];
  // Reasoning traces are emitted as `thought` parts so Accio keeps them out of
  // the visible message body (see textFrame / textFromParts).
  const reasoning = firstDefined(message.reasoning_content, message.reasoning);
  if (isNonEmptyString(reasoning)) parts.push({ text: reasoning, thought: true });
  if (isNonEmptyString(message.content)) parts.push({ text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const parsedArgs = parseToolArguments(call.function?.arguments);
      parts.push({
        functionCall: {
          ...(call.id ? { id: call.id } : {}),
          name: call.function?.name,
          args: parsedArgs,
          argsJson: JSON.stringify(parsedArgs),
        },
      });
    }
  }
  const frame = {
    content: { role: 'model', parts },
    turnComplete: true,
    finishReason: mapFinishReason(choice?.finish_reason),
  };
  const usage = toUsageMetadata(completion?.usage);
  if (usage) frame.usageMetadata = usage;
  return frame;
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_TOOL_SCHEMA,
  resolveEndpoint,
  extractSystemInstruction,
  toOpenAIMessages,
  toOpenAITools,
  readGenerationOptions,
  toOpenAIRequest,
  toOllamaRequest,
  contentFromParts,
  normalizeResponseFormat,
  resolveToolCallArgs,
  textFrame,
  toolCallsFrame,
  doneFrame,
  mapFinishReason,
  toUsageMetadata,
  parseToolArguments,
  genAIResponseToOpenAI,
  openAIResponseToGenAI,
  isObject,
};
