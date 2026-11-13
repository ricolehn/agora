// The connections to the AI services (Settings → AI): Anthropic, Google and OpenAI through their own interfaces, any
// other service through the OpenAI-compatible one. Each speaks its service's protocol for the turns of a question;
// the question itself - lookups, limits, permissions - is the same for all of them (routes/ai.js).
//
// A connection: start({ system, messages }) - the conversation in the service's format; turn(state, request, ctx) -
// one turn of the model, its thoughts and text streamed through ctx.out, the lookups it asks for returned;
// refused(failed, request, { lookedUp }) - which part of a refused request to leave out (or which effort level to
// try instead); addLookups(state, turn, results) - the model's turn and the results of its lookups, appended.
const ADAPTERS = {
  anthropic: require('./anthropic'),
  gemini: require('./gemini'),
  openai: require('./openai'),
  custom: require('./custom')
};

/** The connection for the service [id] ('anthropic', 'gemini', 'openai'; anything else: OpenAI-compatible). */
const adapterFor = (id) => ADAPTERS[id] || ADAPTERS.custom;

module.exports = { adapterFor, ...require('./shared') };
