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
const DEFAULT_TOOL_SCHEMA = { type: 'object', properties: {} };

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

/** Join a base URL with a path, tolerating trailing/leading slashes. */
function resolveEndpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(suffix || '').replace(/^\/+/, '');
  return path ? `${base}/${path}` : base;
}

/** Collect text from a `parts` array (strings or `{ text }` objects). */
function textFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  const chunks = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!isObject(part)) continue;
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
  const groups = [];
  if (Array.isArray(body.tools)) groups.push(...body.tools);
  if (Array.isArray(body.functionDeclarations)) groups.push(...body.functionDeclarations);

  const tools = [];
  const seen = new Set();

  const addDeclaration = (decl) => {
    if (!isObject(decl)) return;
    const name = decl.name || decl.functionName || decl.id;
    if (!isNonEmptyString(name) || seen.has(name)) return;
    seen.add(name);
    const parameters = firstDefined(decl.parameters, decl.args, decl.parametersJsonSchema);
    tools.push({
      type: 'function',
      function: {
        name,
        description: typeof decl.description === 'string' ? decl.description : '',
        parameters: isObject(parameters) ? parameters : DEFAULT_TOOL_SCHEMA,
      },
    });
  };

  for (const group of groups) {
    if (!isObject(group)) continue;
    if (Array.isArray(group.functionDeclarations)) {
      group.functionDeclarations.forEach(addDeclaration);
      continue;
    }
    if (isObject(group.function)) {
      addDeclaration(group.function);
      continue;
    }
    addDeclaration(group);
  }

  return tools;
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

    const functionResponses = parts.filter(
      (part) => isObject(part) && isObject(part.functionResponse),
    );
    const functionCalls = parts.filter((part) => isObject(part) && isObject(part.functionCall));

    if (functionResponses.length > 0) {
      for (const part of functionResponses) {
        const response = part.functionResponse;
        const name = firstDefined(response.name, response.id, 'tool');
        const rawPayload = firstDefined(
          response.response,
          response.result,
          typeof response.responseJson === 'string' ? safeJsonParse(response.responseJson, response.responseJson) : undefined,
          {},
        );
        const payload = isObject(rawPayload) && rawPayload.__raw ? rawPayload.__raw : rawPayload;
        messages.push({
          role: 'tool',
          tool_call_id: String(firstDefined(response.id, response.callId, response.toolCallId, `call_${name}_${callSeq++}`)),
          name: typeof name === 'string' ? name : undefined,
          content: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
        });
      }
      if (text.trim()) messages.push({ role: 'user', content: text });
      continue;
    }

    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((part) => {
        const call = part.functionCall;
        const rawArgs = firstDefined(
          call.args,
          call.arguments,
          typeof call.argsJson === 'string' ? safeJsonParse(call.argsJson, {}) : undefined,
          {},
        );
        const args = isObject(rawArgs) && rawArgs.__raw ? safeJsonParse(rawArgs.__raw, {}) : rawArgs;
        return {
          id: String(firstDefined(call.id, call.callId, `call_${callSeq++}`)),
          type: 'function',
          function: {
            name: String(firstDefined(call.name, call.functionName, 'tool')),
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      });
      messages.push({ role: 'assistant', content: text.trim() ? text : null, tool_calls: toolCalls });
      continue;
    }

    if (role === 'model' || role === 'assistant') {
      messages.push({ role: 'assistant', content: text });
      continue;
    }
    if (role === 'tool' || role === 'function') {
      messages.push({ role: 'tool', tool_call_id: `call_${role}_${callSeq++}`, content: text });
      continue;
    }
    messages.push({ role: 'user', content: text });
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

/** Streaming chunk -> Accio SSE frame carrying text. */
function textFrame(text) {
  return {
    content: { role: 'model', parts: [{ text }] },
    turnComplete: false,
  };
}

/** Streaming tool-call turn -> single Accio SSE frame. */
function toolCallsFrame(calls) {
  return {
    content: {
      role: 'model',
      parts: calls.map((call) => {
        const parsedArgs = isObject(call.args) ? call.args : safeJsonParse(call.args, {});
        return {
          functionCall: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            args: parsedArgs,
            argsJson: JSON.stringify(parsedArgs),
          },
        };
      }),
    },
    turnComplete: true,
    finishReason: 'TOOL_CALLS',
  };
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
