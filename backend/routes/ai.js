const express = require('express');
const {
  context,
  verifyToken,
  verifySuperAdmin,
  verifyAiAccess,
  aiChatRateLimit,
  broadcastDataUpdate
} = require('../context');

const {
  getAiSettings,
  setAiSettings,
  buildDatabaseSnapshot,
  buildSystemPrompt,
  sanitizeAiMessages,
  aiStreamEvents
} = require('../ai');

// While a model thinks, nothing may flow for minutes: a comment line every 15 s keeps proxies and the browser
// from closing the connection. A reply never takes longer than 10 minutes.
const AI_HEARTBEAT_MS = 15000;
const AI_MAX_MS = 10 * 60 * 1000;

const router = express.Router();

router.get('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    res.json({
      enabled: aiSettings.enabled,
      baseUrl: aiSettings.baseUrl || '',
      apiKey: '***',
      model: aiSettings.model || ''
    });
  } catch (err) {
    console.error('Failed to get AI config:', err);
    res.status(500).json({ error: 'Failed to get AI config' });
  }
});

router.get('/api/admin/ai-status', verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    res.json({ enabled: !!aiSettings.enabled });
  } catch (err) {
    res.json({ enabled: false });
  }
});

router.put('/api/admin/ai-config', verifyToken, verifySuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    // The stored key only goes to the address it was entered for: a new address needs the key again
    const current = await getAiSettings(context.appConfig);
    const newBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.baseUrl;
    const keepsKey = typeof body.apiKey !== 'string' || body.apiKey === '***';
    if (current.apiKey && keepsKey && (newBaseUrl || '') !== (current.baseUrl || '')) {
      return res.status(400).json({ error: 'Please enter the API key again for a new API address.' });
    }
    if (newBaseUrl && !/^https?:\/\//i.test(newBaseUrl)) {
      return res.status(400).json({ error: 'The API address must start with http:// or https://.' });
    }
    await setAiSettings(context.appConfig, body);
    broadcastDataUpdate();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save AI config:', err);
    res.status(500).json({ error: 'Failed to save AI config' });
  }
});

router.post('/api/ai/chat', aiChatRateLimit, verifyToken, verifyAiAccess, async (req, res) => {
  try {
    const aiSettings = await getAiSettings(context.appConfig);
    if (!aiSettings.enabled) {
      return res.status(403).json({ error: 'AI support is not enabled' });
    }

    const rawMessages = req.body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const messages = sanitizeAiMessages(rawMessages, 50, 12000);
    if (messages.length === 0) {
      return res.status(400).json({ error: 'No valid non-empty messages found in payload' });
    }

    const baseUrl = (aiSettings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const apiKey = aiSettings.apiKey || '';
    const model = aiSettings.model || 'gpt-4o-mini';

    const canViewFinances = req.user?.canViewFinances === true || req.user?.canManageFinances === true;
    const dbSnapshot = await buildDatabaseSnapshot(context.appConfig, { canViewFinances, user: req.user });
    const systemContent = buildSystemPrompt(context.appConfig.appName, dbSnapshot, { canViewFinances });

    // From here on everything goes out as server-sent events, errors too ("data: {error}"), so the connection
    // is open (and kept alive) while the provider is still thinking about its first word
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = event => { if (!res.writableEnded) res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, AI_HEARTBEAT_MS);
    const upstream = new AbortController();
    const deadline = setTimeout(() => upstream.abort(), AI_MAX_MS);
    // The person left (new chat, other page, app closed): stop asking the provider
    res.on('close', () => upstream.abort());

    try {
      const aiRes = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemContent }, ...messages],
          stream: true
        }),
        signal: upstream.signal
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text().catch(() => '');
        console.error('AI provider error:', aiRes.status, errText);
        let detailMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          if (parsed.error?.message) detailMsg = parsed.error.message;
        } catch {}
        send({ error: String(detailMsg || `AI provider returned ${aiRes.status}`).slice(0, 300) });
        return;
      }

      const reader = aiRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handleLine = line => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          for (const event of aiStreamEvents(JSON.parse(data))) send(event);
        } catch { /* skip malformed chunks */ }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(handleLine);
        }
        handleLine(buffer + decoder.decode());
      } finally {
        reader.releaseLock();
      }
      send('[DONE]');
    } catch (err) {
      if (!res.writableEnded && !res.destroyed) {
        console.error('AI chat stream error:', err);
        send({ error: upstream.signal.aborted ? 'The AI took too long to answer.' : 'AI chat request failed' });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      res.end();
    }
  } catch (err) {
    console.error('AI chat error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI chat request failed' });
    } else {
      res.end();
    }
  }
});

module.exports = router;
