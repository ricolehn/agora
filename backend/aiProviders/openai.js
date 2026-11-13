// OpenAI through its own interface, the Responses API: its reasoning models share a summary of their thoughts
// (reasoning.summary), which the chat shows, and the effort level sets how much they think (reasoning.effort).
// Nothing is kept at OpenAI (store: false): the model's reasoning goes back encrypted with the next turn of the
// question. Models without reasoning refuse those parts once; the chat remembers that.
const { TOOLS_REFUSED, mayBeRefusal, readEvents, fromFirstQuestion } = require('./shared');

// The effort levels as reasoning.effort
const EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };
const LOWER = { xhigh: 'high', max: 'high' };

module.exports = {
  start: ({ system, messages }) => ({ instructions: system, input: fromFirstQuestion(messages).map((message) => ({ role: message.role, content: message.content })) }),

  async turn(state, request, { provider, apiKey, signal, out }) {
    const leave = request.leaveOut;
    const body = { model: provider.model, instructions: state.instructions, input: state.input, stream: true, store: false };
    if (request.tools.length) {
      body.tools = request.tools.map(({ function: tool }) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
      body.tool_choice = request.toolChoice === 'none' ? 'none' : 'auto';
    }
    const effort = leave.has('effort') ? null : EFFORT[request.level] || null;
    if (!leave.has('reasoning')) {
      body.reasoning = { ...(effort ? { effort } : {}), ...(leave.has('summary') ? {} : { summary: 'auto' }) };
      body.include = ['reasoning.encrypted_content'];
    }
    const sent = { tools: Boolean(body.tools), reasoning: Boolean(body.reasoning), effort: Boolean(body.reasoning?.effort), summary: Boolean(body.reasoning?.summary) };

    const response = await fetch(`${provider.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) return { ok: false, status: response.status, text: await response.text().catch(() => ''), sent };

    let output = null;
    let failure = null;
    let text = '';
    let thought = false;
    await readEvents(response, (data) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      switch (event?.type) {
        case 'response.reasoning_summary_part.added':
          // Every part of the summary is a step of its own
          if (thought) out.reasoning('\n\n');
          break;
        case 'response.reasoning_summary_text.delta':
          thought = true;
          out.reasoning(event.delta);
          break;
        case 'response.output_text.delta':
          text += event.delta || '';
          out.content(event.delta);
          break;
        case 'response.completed':
        case 'response.incomplete':
          output = Array.isArray(event.response?.output) ? event.response.output : [];
          break;
        case 'response.failed':
          failure = event.response?.error?.message || 'The AI could not answer.';
          break;
        case 'error':
          failure = event.message || event.error?.message || 'AI provider error';
          break;
        default:
      }
    });
    if (failure) {
      out.error(failure);
      return { ok: true, calls: [], text, native: [] };
    }
    const items = output || [];
    const calls = items.filter((item) => item.type === 'function_call')
      .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments || '{}' }));
    return { ok: true, calls, text, native: items };
  },

  refused(failed, request, { lookedUp }) {
    if (!failed.sent || !mayBeRefusal(failed)) return null;
    const { sent } = failed;
    const text = failed.text || '';
    // Reasoning summaries need a verified organization; the effort and the thinking itself still work without them
    if (sent.summary && /summar/i.test(text) && /verif/i.test(text)) return { part: 'summary', remember: true };
    // A model that knows no "xhigh": one level lower
    if (sent.effort && /effort/i.test(text) && /value/i.test(text) && LOWER[request.level]) return { level: LOWER[request.level] };
    // A model without reasoning: no reasoning parts at all
    if (sent.reasoning && /reasoning|encrypted|summar/i.test(text)) return { part: 'reasoning', remember: true };
    if (sent.tools && !lookedUp && TOOLS_REFUSED.test(text)) return { part: 'tools', remember: true };
    return null;
  },

  addLookups(state, turn, results) {
    // The model's reasoning (encrypted), its words and its calls go back as they came, then the results
    state.input.push(...turn.native);
    for (const { call, result } of results) state.input.push({ type: 'function_call_output', call_id: call.id, output: result });
  }
};
