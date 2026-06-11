import Anthropic from '@anthropic-ai/sdk';

// The model adapter is the swappable seam. One method: complete(system, messages, tools).
// Returns { assistantContent, text, toolCalls: [{id, name, args}], stopReason, usage }.
export class ClaudeAdapter {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.WALLENUT_MODEL || 'claude-opus-4-8', maxTokens = 8192 } = {}) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxTokens = maxTokens;
  }

  // Translate provider-neutral JSON Schema tools to Anthropic's { name, description, input_schema }.
  _toAnthropicTools(tools) {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  async complete(system, messages, tools) {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      tools: this._toAnthropicTools(tools),
    });

    const content = res.content; // raw block array — round-trip this back as the assistant turn
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));

    return {
      assistantContent: content,
      text,
      toolCalls,
      stopReason: res.stop_reason,
      usage: res.usage, // { input_tokens, output_tokens, ... }
    };
  }
}
