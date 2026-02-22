const { parseCsvEnv, applyStatusFilter } = require('../utils/firestoreFilters');

async function publishContentHandler({ admin, db }, req, res) {
  try {
    const now = admin.firestore.Timestamp.now();
    const start = admin.firestore.Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);

    const statuses = parseCsvEnv('PUBLISH_STATUSES', ['Uploaded']);

    let query = db.collection('posts');
    query = applyStatusFilter(query, statuses);
    const snapshot = await query
      .where('scheduledPublishTime', '>=', start)
      .where('scheduledPublishTime', '<=', now)
      .get();

    const posts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.json({ count: posts.length, posts });
  } catch (err) {
    res.status(500).json({ error: 'Internal error', details: String(err && err.message ? err.message : err) });
  }
}

module.exports = {
  publishContentHandler
};
