// Errors meant for the person who asked: thrown with an HTTP status anywhere in the server (a route, a rule, a store)
// and answered with their own text - by the routes of API v1 (routes/http.js) and of v2 (v2/http.js). Anything else
// that goes wrong is the server's own failure: logged, and answered without its inner workings. The English text is
// also the key of its translation (locales/de.json).

/** An error answered with [status] and [message]; [extra] adds fields to the error (v2 reads params and field). */
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

const invalid = (message, extra) => httpError(400, message, extra);
const unauthorized = (message) => httpError(401, message);
const forbidden = (message) => httpError(403, message);
const notFound = (message) => httpError(404, message);
const conflict = (message) => httpError(409, message);
const unavailable = (message, extra) => httpError(503, message, extra);

module.exports = { httpError, invalid, unauthorized, forbidden, notFound, conflict, unavailable };
