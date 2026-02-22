const express = require('express');
const { initFirebase } = require('./config/firebase');
const { publishContentHandler } = require('./handlers/publishContent');

const app = express();
app.use(express.json({ limit: '10mb' }));

const port = process.env.PORT || 8080;

const { admin, db, storage } = initFirebase();

app.get('/api/content/publish', async (req, res) => {
  return publishContentHandler({ db, storage }, req, res);
});

app.listen(port, () => {
  process.stdout.write(`Listening on port ${port}\n`);
});
