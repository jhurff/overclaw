'use strict';

const { ThemeError } = require('./themePacks');

function send(res, fn) {
  try {
    res.json(fn());
  } catch (err) {
    const status = err instanceof ThemeError && err.status ? err.status : 400;
    res.status(status).json({ error: err.message || 'Theme request failed' });
  }
}

function registerThemeRoutes(app, themeStore) {
  app.get('/api/themes', (req, res) => {
    send(res, () => ({
      themes: themeStore.list(),
      active: themeStore.getActive(),
    }));
  });

  app.get('/api/themes/active', (req, res) => {
    send(res, () => themeStore.getActive());
  });

  app.post('/api/themes/active', (req, res) => {
    send(res, () => {
      const id = req.body && req.body.id;
      return themeStore.setActive(id);
    });
  });

  app.post('/api/themes/reset', (req, res) => {
    send(res, () => themeStore.reset());
  });

  app.post('/api/themes/import', (req, res) => {
    send(res, () => {
      const body = req.body || {};
      if (body.zipBase64) {
        let buf;
        try { buf = Buffer.from(String(body.zipBase64), 'base64'); }
        catch { throw new ThemeError('Zip payload is not valid base64'); }
        if (!buf.length) throw new ThemeError('Zip payload is empty');
        return themeStore.importZip(buf);
      }
      const pack = body.pack && typeof body.pack === 'object' ? body.pack : body;
      return themeStore.importJson(pack);
    });
  });

  app.delete('/api/themes/:id', (req, res) => {
    send(res, () => themeStore.remove(req.params.id));
  });

  app.get('/manifest.webmanifest', (req, res) => {
    let active;
    try { active = themeStore.getActive(); }
    catch { active = { themeColor: '#000000', tokens: { '--oc-bg': '#000000' } }; }
    res.set('Cache-Control', 'no-cache');
    res.type('application/manifest+json');
    res.json({
      name: 'OverClaw',
      short_name: 'OverClaw',
      description: 'Swarm oversight dashboard',
      start_url: '/swarm',
      scope: '/',
      display: 'standalone',
      background_color: (active.tokens && active.tokens['--oc-bg']) || '#000000',
      theme_color: active.themeColor || '#000000',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    });
  });

  app.get('/settings/themes', (req, res) => {
    res.render('themes', { title: 'Themes', currentPath: '/settings/themes' });
  });
}

module.exports = registerThemeRoutes;
