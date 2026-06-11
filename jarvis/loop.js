export const MAX_STEPS = 25;
export const TOKEN_BUDGET = 200_000;

export const SYSTEM_PROMPT =
  "You are Jarvis, Allen's local agent. You have tools to read/write/edit files and run bash. " +
  'Use them to complete the task, then report.';

// The agent loop. Runs one task to completion against an adapter + tool registry.
// onEvent(evt) is an optional sink for surfacing tool calls / results to a UI or REPL.
//   evt: { type: 'tool_call', name, args } | { type: 'tool_result', name, result }
//
// `messages` is the running conversation (mutated in place so a REPL can keep state across turns).
export async function runLoop({ adapter, registry, tools, messages, onEvent = () => {}, system = SYSTEM_PROMPT }) {
  let totalTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await adapter.complete(system, messages, tools);

    if (reply.usage) {
      totalTokens += (reply.usage.input_tokens || 0) + (reply.usage.output_tokens || 0);
    }

    // Append the assistant's full content so the conversation round-trips correctly.
    messages.push({ role: 'assistant', content: reply.assistantContent });

    // No tool calls => the model is done. Return its text.
    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      return { text: reply.text, stopReason: reply.stopReason, steps: step + 1, totalTokens };
    }

    // Run each tool call sequentially, each in its own try/catch.
    const results = [];
    for (const call of reply.toolCalls) {
      onEvent({ type: 'tool_call', name: call.name, args: call.args });
      let result;
      try {
        const tool = registry[call.name];
        if (!tool) result = `Error: unknown tool "${call.name}".`;
        else result = await tool.run(call.args || {});
      } catch (err) {
        // A thrown tool error becomes a string result fed back — never crashes the loop.
        result = `Error: ${err && err.message ? err.message : String(err)}`;
      }
      onEvent({ type: 'tool_result', name: call.name, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result });
    }

    messages.push({ role: 'user', content: results });

    // Cost ceiling: abort with a clear message if cumulative tokens exceed the budget.
    if (totalTokens > TOKEN_BUDGET) {
      return {
        text: `Aborted: token budget of ${TOKEN_BUDGET} exceeded (used ~${totalTokens}).`,
        stopReason: 'token_budget_exceeded',
        steps: step + 1,
        totalTokens,
      };
    }
  }

  return { text: `Aborted: reached MAX_STEPS (${MAX_STEPS}) without finishing.`, stopReason: 'max_steps', steps: MAX_STEPS, totalTokens };
}
