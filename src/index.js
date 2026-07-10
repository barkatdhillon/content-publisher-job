const express = require('express');
const { initFirebase } = require('./config/firebase');
const { createLogger } = require('./utils/logger');
const { publishContentHandler, syncPinterestBoards, generatePinterestTokens, generateTikTokTokens} = require('./handlers/publishContent');

const log = createLogger('index');

// These fire for errors that escape every local try/catch (e.g. a bug in a
// handler that forgets to catch, or a rejected promise nobody awaited).
// Without this, Cloud Run only shows the container being killed/restarted
// with no application-level reason.
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception - process will exit', {}, error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', {}, reason);
});

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode}`, { durationMs: Date.now() - startedAt });
  });
  next();
});

const port = process.env.PORT || 8080;

const { admin, db, storage } = initFirebase();

app.get('/api/content/publish', async (req, res) => {
  return publishContentHandler({ db, storage }, req, res);
});

app.get('/api/pinterest/sync-boards', async (req, res) => {
  return syncPinterestBoards(db, req, res);
});

app.get('/api/pinterest/generate-tokens', async (req, res) => {
  return generatePinterestTokens(db, req, res);
});

app.get('/api/tiktok/generate-tokens', async (req, res) => {
  return generateTikTokTokens(db, req, res);
});

app.listen(port, () => {
  process.stdout.write(`Listening on port ${port}\n`);
});
