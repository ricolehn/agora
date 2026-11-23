// How the routes of the first API answer when something goes wrong, as v2/http.js does for API v2: an error meant for
// the person who asked (httpError.js, thrown anywhere below the route) with its status and text, anything else as the
// route's own failure - logged, and answered with the route's text, never with the server's inner workings.

/**
 * [handler] with the answer to whatever it throws; [failure] is the route's text when the server itself failed. It runs
 * as a step of the route, so API v2 calls it the same way when it runs the old API's handlers (v2/http.js runV1).
 */
function route(failure, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (err?.expose && !res.headersSent) return res.status(err.status).json({ error: err.message });
      console.error(`[API] ${req.method} ${req.originalUrl || req.path}: ${failure}`, err);
      if (!res.headersSent) res.status(500).json({ error: failure });
    }
  };
}

module.exports = { route };
