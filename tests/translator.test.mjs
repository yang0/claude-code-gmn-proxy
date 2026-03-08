import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToResponsesRequest,
  openaiResponseToAnthropic,
  convertOpenAIEventToAnthropicSse,
} from '../src/translator.mjs';

const config = {
  defaultModel: 'gpt-5.4',
  reasoningEffort: 'high',
};

test('anthropicToResponsesRequest maps text, system, tool config, tool history, and tool results', () => {
  const request = {
    model: 'gpt-5.4',
    system: [
      { type: 'text', text: 'System A' },
      { type: 'text', text: 'System B' },
    ],
    tools: [
      {
        name: 'run_bash',
        description: 'Run a bash command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'run_bash' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'List files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the workspace.' },
          { type: 'tool_use', id: 'toolu_1', name: 'run_bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb\n', is_error: false },
          { type: 'text', text: 'Summarize it.' },
        ],
      },
    ],
    stream: true,
    max_tokens: 2048,
  };

  const mapped = anthropicToResponsesRequest(request, config);

  assert.equal(mapped.model, 'gpt-5.4');
  assert.equal(mapped.stream, true);
  assert.equal(mapped.max_output_tokens, 2048);
  assert.equal(mapped.instructions, 'System A\n\nSystem B');
  assert.equal(mapped.tools.length, 1);
  assert.deepEqual(mapped.tool_choice, { type: 'function', name: 'run_bash' });
  assert.equal(mapped.input.length, 3);
  assert.deepEqual(mapped.input[0], {
    role: 'user',
    content: [{ type: 'input_text', text: 'List files' }],
  });
  assert.deepEqual(mapped.input[1], {
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'I will inspect the workspace.' },
      {
        type: 'output_text',
        text: '[tool_call id=toolu_1 name=run_bash input={"command":"ls"}]',
      },
    ],
  });
  assert.deepEqual(mapped.input[2], {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: '[tool_result id=toolu_1 name=run_bash is_error=false]\na\nb\n',
      },
      { type: 'input_text', text: 'Summarize it.' },
    ],
  });
});

test('openaiResponseToAnthropic maps message output and tool calls', () => {
  const response = {
    id: 'resp_1',
    model: 'gpt-5.4',
    output: [
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'run_bash',
        arguments: '{"command":"pwd"}',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 2 },
    },
  };

  const mapped = openaiResponseToAnthropic(response, 'gpt-5.4');

  assert.equal(mapped.type, 'message');
  assert.equal(mapped.model, 'gpt-5.4');
  assert.equal(mapped.stop_reason, 'tool_use');
  assert.deepEqual(mapped.content, [
    { type: 'tool_use', id: 'call_123', name: 'run_bash', input: { command: 'pwd' } },
    { type: 'text', text: 'done' },
  ]);
  assert.deepEqual(mapped.usage, {
    input_tokens: 8,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
  });
});

test('convertOpenAIEventToAnthropicSse emits Anthropic SSE frames for text streaming', () => {
  const state = {};
  const frames = [];
  for (const event of [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4' } },
    { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] }, output_index: 0 },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'PO' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'NG' },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'PONG' } },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.4', output: [{ type: 'message', content: [{ type: 'output_text', text: 'PONG' }] }], usage: { input_tokens: 5, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } },
  ]) {
    frames.push(...convertOpenAIEventToAnthropicSse(event, state));
  }

  assert.equal(frames[0].event, 'message_start');
  assert.equal(frames[1].event, 'content_block_start');
  assert.equal(frames[2].event, 'content_block_delta');
  assert.equal(frames[3].event, 'content_block_delta');
  assert.equal(frames[4].event, 'content_block_stop');
  assert.equal(frames[5].event, 'message_delta');
  assert.equal(frames[6].event, 'message_stop');
  assert.equal(frames[2].data.delta.text, 'PO');
  assert.equal(frames[3].data.delta.text, 'NG');
  assert.equal(frames[5].data.delta.stop_reason, 'end_turn');
});
