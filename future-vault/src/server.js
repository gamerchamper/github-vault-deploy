const express = require('express');
const path = require('path');
const { createPlexApiRouter } = require('./routes/plex-api');
const { createDashboardRouter } = require('./routes/dashboard');
const { createStreamProxyRouter } = require('./routes/stream-proxy');

function createApp(getConfig) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'future-vault', version: '1.0.0' });
  });

  app.use(createStreamProxyRouter(getConfig));
  app.use('/api/plex', createPlexApiRouter(getConfig));
  app.use(createDashboardRouter(getConfig));

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
