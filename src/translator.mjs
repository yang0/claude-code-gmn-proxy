import crypto from 'node:crypto';

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeContentString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item?.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }
      return JSON.stringify(item);
    }).join('\n');
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content);
}

function buildToolNameMap(messages = []) {
  const map = new Map();
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block?.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

function anthropicBlockToResponsesBlock(block, role, toolNameMap) {
  if (!block || typeof block !== 'object') {
    return null;
  }
  if (block.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: block.text || '',
    };
  }
  if (block.type === 'tool_use' && role === 'assistant') {
    return {
      type: 'output_text',
      text: `[tool_call id=${block.id} name=${block.name} input=${JSON.stringify(block.input || {})}]`,
    };
  }
  if (block.type === 'tool_result') {
    const toolName = toolNameMap.get(block.tool_use_id) || 'unknown_tool';
    return {
      type: 'input_text',
      text: `[tool_result id=${block.tool_use_id} name=${toolName} is_error=${Boolean(block.is_error)}]\n${normalizeContentString(block.content)}`,
    };
  }
  if (block.type === 'image' && role !== 'assistant') {
    const source = block.source || {};
    if (source.type === 'base64' && source.media_type && source.data) {
      return {
        type: 'input_image',
        image_url: `data:${source.media_type};base64,${source.data}`,
      };
    }
  }
  return null;
}

function normalizeSystem(system) {
  if (!system) {
    return '';
  }
  if (typeof system === 'string') {
    return system.trim();
  }
  if (Array.isArray(system)) {
    return system
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function mapToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') {
    return 'auto';
  }
  if (toolChoice === 'none') {
    return 'none';
  }
  if (toolChoice === 'any') {
    return 'required';
  }
  if (toolChoice?.type === 'tool' && toolChoice.name) {
    return { type: 'function', name: toolChoice.name };
  }
  return 'auto';
}

function mapReasoningEffort(raw) {
  switch ((raw || '').toLowerCase()) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    default:
      return 'medium';
  }
}

export function anthropicToResponsesRequest(request, config = {}) {
  const toolNameMap = buildToolNameMap(request.messages);
  const input = (request.messages || []).map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = (message.content || [])
      .map((block) => anthropicBlockToResponsesBlock(block, role, toolNameMap))
      .filter(Boolean);
    return { role, content };
  }).filter((item) => item.content.length > 0);

  const tools = (request.tools || []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {}, additionalProperties: true },
  }));

  const mapped = {
    model: request.model || config.defaultModel,
    input,
    stream: Boolean(request.stream),
    max_output_tokens: request.max_tokens,
    instructions: normalizeSystem(request.system),
    reasoning: { effort: mapReasoningEffort(config.reasoningEffort) },
  };

  if (tools.length > 0) {
    mapped.tools = tools;
    mapped.tool_choice = mapToolChoice(request.tool_choice);
  }

  return mapped;
}

function responseUsageToAnthropic(usage = {}) {
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (usage.input_tokens || 0) - cached),
    output_tokens: usage.output_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function openaiResponseToAnthropic(response, modelOverride) {
  const content = [];
  let hasToolUse = false;

  for (const item of response.output || []) {
    if (item.type === 'function_call') {
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: item.call_id || `call_${crypto.randomBytes(6).toString('hex')}`,
        name: item.name,
        input: safeJsonParse(item.arguments || '{}', {}),
      });
      continue;
    }
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text') {
          content.push({ type: 'text', text: part.text || '' });
        }
      }
    }
  }

  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: modelOverride || response.model,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: responseUsageToAnthropic(response.usage),
  };
}

function initState(state, response) {
  if (state.initialized) {
    return [];
  }
  state.initialized = true;
  state.model = response?.model || state.model || 'unknown-model';
  state.messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  state.blockIndex = 0;
  state.blockOpen = false;
  state.sawToolUse = false;
  return [{
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  }];
}

export function convertOpenAIEventToAnthropicSse(event, state = {}) {
  const frames = [];
  if (event.type === 'response.created') {
    frames.push(...initState(state, event.response));
    return frames;
  }

  if (!state.initialized && event.response) {
    frames.push(...initState(state, event.response));
  }

  if (event.type === 'response.content_part.added' && event.part?.type === 'output_text') {
    frames.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: { type: 'text', text: '' },
      },
    });
    state.blockOpen = true;
    return frames;
  }

  if (event.type === 'response.output_text.delta') {
    frames.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: { type: 'text_delta', text: event.delta || '' },
      },
    });
    return frames;
  }

  if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
    state.sawToolUse = true;
    frames.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: state.blockIndex,
        content_block: {
          type: 'tool_use',
          id: event.item.call_id,
          name: event.item.name,
          input: {},
        },
      },
    });
    state.blockOpen = true;
    return frames;
  }

  if (event.type === 'response.function_call_arguments.delta') {
    frames.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: state.blockIndex,
        delta: { type: 'input_json_delta', partial_json: event.delta || '' },
      },
    });
    return frames;
  }

  if (event.type === 'response.content_part.done' || event.type === 'response.output_item.done') {
    if (state.blockOpen) {
      frames.push({
        event: 'content_block_stop',
        data: {
          type: 'content_block_stop',
          index: state.blockIndex,
        },
      });
      state.blockIndex += 1;
      state.blockOpen = false;
    }
    return frames;
  }

  if (event.type === 'response.completed') {
    if (state.blockOpen) {
      frames.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: state.blockIndex },
      });
      state.blockIndex += 1;
      state.blockOpen = false;
    }

    const usage = responseUsageToAnthropic(event.response?.usage);
    frames.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: state.sawToolUse ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage.output_tokens,
        },
      },
    });
    frames.push({
      event: 'message_stop',
      data: { type: 'message_stop' },
    });
  }

  return frames;
}
