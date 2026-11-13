import test from 'node:test';
import assert from 'node:assert/strict';
import { activityEvent, displayText, publicEvent, validThreadId } from './core.mjs';

test('accepts only exact thread UUID', () => {
  assert.equal(validThreadId('12345678-1234-4123-8123-123456789abc'), true);
  assert.equal(validThreadId("x'; DROP TABLE threads; --"), false);
});

test('filters progress to user-visible assistant text', () => {
  const message = publicEvent({
    type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 't1', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: 'Working' }] } }
  }, 5);
  assert.deepEqual(message, { seq: 5, kind: 'message', phase: 'commentary', text: 'Working', turnId: 't1' });
  const command = publicEvent({
    type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 't1', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'printf ok'], cwd: '/tmp', aggregated_output: '\x1b[32mok\x1b[0m\r\n', exit_code: 0, status: 'completed' } }
  }, 6);
  assert.equal(command, null);
  assert.deepEqual(activityEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'printf ok'], cwd: '/tmp', aggregated_output: '\x1b[32mok\x1b[0m', exit_code: 0, status: 'completed' } } }), { time: null, status: 'completed', activity: 'CommandExecution', command: 'printf ok', cwd: '/tmp', exitCode: 0, output: 'ok' });
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { 'secret.txt': {} } } } }, 6), null);
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', result: { private: 'data' } } } }, 6), null);
  assert.equal(publicEvent({ type: 'response_item', payload: { type: 'reasoning', raw_content: 'private' } }, 7), null);
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'analysis', content: [{ type: 'text', text: 'private' }] } } }, 8), null);
  assert.deepEqual(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Hello from Codex' }] } } }, 8), { seq: 8, kind: 'message', phase: 'final_answer', text: 'Hello from Codex', turnId: undefined });
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer', content: [] } } }, 8), null);
  assert.deepEqual(publicEvent({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Continue&#x20;this chat' }] } } }, 9), { seq: 9, kind: 'user_message', text: 'Continue this chat', turnId: undefined });
  assert.equal(displayText('one\x1b[31mtwo\x1b[0m\x00 three'), 'onetwo three');
});

test('marks turn boundaries', () => {
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } }, 8).kind, 'started');
  assert.equal(publicEvent({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'done' } }, 9).kind, 'completed');
});
