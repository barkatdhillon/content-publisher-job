const express = require('express');
const { initFirebase } = require('./config/firebase');
const { publishContentHandler, syncPinterestBoards, generatePinterestTokens } = require('./handlers/publishContent');

const app = express();
app.use(express.json({ limit: '10mb' }));

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

app.listen(port, () => {
  process.stdout.write(`Listening on port ${port}\n`);
});
