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
  sanitizeAiMessages
} = require('../ai');

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
      return res.status(400).json({ error: 'Bei einer neuen API-Adresse bitte den API-Key erneut eingeben.' });
    }
    if (newBaseUrl && !/^https?:\/\//i.test(newBaseUrl)) {
      return res.status(400).json({ error: 'Die API-Adresse muss mit http:// oder https:// beginnen.' });
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
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('AI provider error:', aiRes.status, errText);
      let detailMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) {
          detailMsg = parsed.error.message;
        }
      } catch {}
      return res.status(502).json({ error: 'AI provider returned an error', detail: String(detailMsg || '').slice(0, 300) });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
          } else {
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
              if (typeof content === 'string') {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
              if (typeof reasoning === 'string') {
                res.write(`data: ${JSON.stringify({ reasoning })}\n\n`);
              }
            } catch { /* skip malformed chunks */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
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
