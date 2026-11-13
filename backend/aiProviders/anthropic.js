// Claude through Anthropic's own interface, the Messages API, with Anthropic's official SDK (@anthropic-ai/sdk):
//  - Claude's thinking comes as a readable summary (thinking: adaptive, display "summarized"), which the chat shows;
//  - the effort level sets how deeply it thinks (output_config.effort: low, medium, high, xhigh, max);
//  - the long context of a question is cached between its turns (cache_control), so a round of lookups does not
//    pay for the whole context again;
//  - on the models that offer it, a question Claude declines is answered by another Claude model chosen by
//    Anthropic for the reason it was declined (server-side fallbacks, "default").
// Claude's thinking blocks go back unchanged with the next turn of a question, as the API requires.
const sdk = require('@anthropic-ai/sdk');
const { TOOLS_REFUSED, mayBeRefusal, fromFirstQuestion } = require('./shared');

const Anthropic = sdk.default || sdk.Anthropic;

// Streaming gives Claude room for long thoughts; only what it writes is billed
const MAX_TOKENS = 64000;
// The models a declined question goes on to another model for, on Anthropic's side
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models without "max" or "xhigh" get the next level down
const LOWER = { max: 'xhigh', xhigh: 'high' };
// Blocks of a model that declined during its answer: not passed back (a fallback block marks where it stopped)
const DECLINED_BLOCKS = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

module.exports = {
  start: ({ system, messages }) => ({ system, messages: fromFirstQuestion(messages).map((message) => ({ role: message.role, content: message.content })) }),

  async turn(state, request, { provider, apiKey, signal, out }) {
    const leave = request.leaveOut;
    const params = { model: provider.model, max_tokens: MAX_TOKENS, system: state.system, messages: state.messages };
    if (request.tools.length) {
      // The lookups' inputs are small; streamed as they are written all the same, they are checked by the lookups
      params.tools = request.tools.map(({ function: tool }) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...(leave.has('eagerInput') ? {} : { eager_input_streaming: true })
      }));
      params.tool_choice = { type: request.toolChoice === 'none' ? 'none' : 'auto' };
    }
    if (!leave.has('thinking')) params.thinking = { type: 'adaptive', display: 'summarized' };
    if (request.level && !leave.has('effort')) params.output_config = { effort: request.level };
    if (!leave.has('cache')) params.cache_control = { type: 'ephemeral' };
    const fallbacks = FALLBACK_MODELS.has(provider.model) && !leave.has('fallbacks');
    const sent = {
      tools: Boolean(params.tools),
      eagerInput: Boolean(params.tools) && !leave.has('eagerInput'),
      thinking: Boolean(params.thinking),
      effort: Boolean(params.output_config),
      cache: Boolean(params.cache_control),
      fallbacks
    };

    const client = new Anthropic({ apiKey, baseURL: provider.baseUrl });
    let message;
    try {
      const stream = fallbacks
        ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
        : client.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'thinking_delta') out.reasoning(event.delta.thinking);
        else if (event.delta.type === 'text_delta') out.content(event.delta.text);
      }
      message = await stream.finalMessage();
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof Anthropic.APIError) {
        return { ok: false, status: err.status ?? 0, text: JSON.stringify(err.error ?? { error: { message: err.message } }), sent };
      }
      // A lookup's input that could not be read (streamed as written): the turn goes again
      return { ok: false, again: true, status: 0, text: String(err?.message || err), sent };
    }

    // Declined, also by the fallback model: no answer (what streamed before is not one)
    if (message.stop_reason === 'refusal') return { ok: false, status: 200, text: '', message: 'The AI declined to answer this question.', sent };
    // What counts is what came after the last fallback block (the declined model's part before it is not passed on)
    const boundary = message.content.map((block) => block.type).lastIndexOf('fallback');
    const current = message.content.slice(boundary + 1);
    const calls = current.filter((block) => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }));
    // A lookup cut off at the end of the room for the answer is not run
    if (calls.length && message.stop_reason === 'max_tokens') return { ok: false, status: 200, text: '', message: 'The answer was cut off.', sent };
    const text = current.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const native = message.content.filter((block, index) => index > boundary || !DECLINED_BLOCKS.has(block.type));
    return { ok: true, calls, text, native };
  },

  refused(failed, request, { lookedUp }) {
    if (!failed.sent || failed.again || !mayBeRefusal(failed) || failed.status === 200) return null;
    const { sent } = failed;
    const text = failed.text || '';
    if (sent.fallbacks && /fallback/i.test(text)) return { part: 'fallbacks', remember: true };
    if (sent.eagerInput && /eager_input_streaming/i.test(text)) return { part: 'eagerInput', remember: true };
    if (sent.effort && /effort/i.test(text)) return LOWER[request.level] ? { level: LOWER[request.level] } : { part: 'effort', remember: true };
    if (sent.thinking && /thinking|adaptive|display/i.test(text)) return { part: 'thinking', remember: true };
    if (sent.cache && /cache_control/i.test(text)) return { part: 'cache', remember: true };
    if (sent.tools && !lookedUp && TOOLS_REFUSED.test(text)) return { part: 'tools', remember: true };
    return null;
  },

  addLookups(state, turn, results) {
    // Claude's turn goes back unchanged (its thinking blocks with their signatures), then all results in one message
    state.messages.push({ role: 'assistant', content: turn.native });
    state.messages.push({ role: 'user', content: results.map(({ call, result }) => ({ type: 'tool_result', tool_use_id: call.id, content: result })) });
  }
};
