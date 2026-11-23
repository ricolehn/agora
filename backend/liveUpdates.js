// Live updates: the apps connected to /api/stream (server-sent events) hear that data changed, and reload it.
const { invalidateAuthCache } = require('./auth');

const sseClients = new Set();
// Tells the connected clients that data changed. [scope] lets them reload only that area ('mentoring', 'events');
// without it they reload everything. [userIds] limits the event to those users (private mentoring chats).
function broadcastDataUpdate(scope = 'all', userIds = null) {
  invalidateAuthCache();
  const message = `event: data_update\ndata: ${JSON.stringify({ scope })}\n\n`;
  for (const client of sseClients) {
    if (userIds && !userIds.includes(client.agoraUserId)) continue;
    client.write(message);
  }
}

module.exports = { sseClients, broadcastDataUpdate };
