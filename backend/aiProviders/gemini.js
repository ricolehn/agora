// Gemini through Google's own interface, the Gemini API: Gemini's thinking comes as a readable summary
// (thinkingConfig.includeThoughts), which the chat shows; it decides itself how long it thinks. The parts of its turns
// - with their thought signatures - go back unchanged with the next turn of a question, as the API requires.
const { TOOLS_REFUSED, mayBeRefusal, readEvents, fromFirstQuestion, resultObject } = require('./shared');

module.exports = {
  start: ({ system, messages }) => ({
    system,
    contents: fromFirstQuestion(messages).map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }))
  }),

  async turn(state, request, { provider, apiKey, signal, out }) {
    const leave = request.leaveOut;
    const body = { systemInstruction: { parts: [{ text: state.system }] }, contents: state.contents };
    if (request.tools.length) {
      body.tools = [{ functionDeclarations: request.tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: request.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    if (!leave.has('thinking')) body.generationConfig = { thinkingConfig: { includeThoughts: true } };
    const sent = { tools: Boolean(body.tools), thinking: Boolean(body.generationConfig) };

    const response = await fetch(`${provider.baseUrl}/v1beta/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) return { ok: false, status: response.status, text: await response.text().catch(() => ''), sent };

    const parts = [];
    const calls = [];
    let text = '';
    let failure = null;
    await readEvents(response, (data) => {
      let chunk;
      try { chunk = JSON.parse(data); } catch { return; }
      if (chunk?.error) {
        failure = chunk.error.message || 'AI provider error';
        return;
      }
      for (const part of chunk?.candidates?.[0]?.content?.parts || []) {
        parts.push(part);
        if (typeof part.text === 'string' && part.text) {
          if (part.thought) out.reasoning(part.text);
          else {
            text += part.text;
            out.content(part.text);
          }
        }
        if (part.functionCall?.name) {
          calls.push({
            id: part.functionCall.id || `call${calls.length + 1}`,
            ownId: part.functionCall.id || null,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {})
          });
        }
      }
    });
    if (failure) {
      out.error(failure);
      return { ok: true, calls: [], text, native: parts };
    }
    return { ok: true, calls, text, native: parts };
  },

  refused(failed, request, { lookedUp }) {
    if (!failed.sent || !mayBeRefusal(failed)) return null;
    const text = failed.text || '';
    if (failed.sent.thinking && /think/i.test(text)) return { part: 'thinking', remember: true };
    if (failed.sent.tools && !lookedUp && TOOLS_REFUSED.test(text)) return { part: 'tools', remember: true };
    return null;
  },

  addLookups(state, turn, results) {
    // Gemini's turn goes back as it came (thought signatures included), then the results as function responses
    state.contents.push({ role: 'model', parts: turn.native });
    state.contents.push({
      role: 'user',
      parts: results.map(({ call, result }) => ({ functionResponse: { ...(call.ownId ? { id: call.ownId } : {}), name: call.name, response: resultObject(result) } }))
    });
  }
};
