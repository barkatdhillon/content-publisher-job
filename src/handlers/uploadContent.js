const { parseCsvEnv, applyStatusFilter } = require('../utils/firestoreFilters');
const { hydratePostUrls } = require('../services/postUrlHydration');
const { uploadToInstagram } = require('./instagramHandler');
const { uploadToFacebook } = require('./facebookHandler');
const { Timestamp } = require('firebase-admin/firestore');

async function uploadContentHandler({ db, storage }, req, res) {
  try {
    const ttlMs = 60 * 60 * 1000;

    const statuses = parseCsvEnv('UPLOAD_STATUSES', ['Scheduled']);
    // Time range
    const now = new Date();
    const istTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const fifteenMinutesAgo = new Date(istTime.getTime() - 15 * 60 * 1000);

    // Convert to Firestore Timestamp
    const nowTimestamp = Timestamp.fromDate(now);
    const earlierTimestamp = Timestamp.fromDate(fifteenMinutesAgo);

    let query = db.collection('posts');
    query = applyStatusFilter(query, statuses);
    // query = query
    // .where('scheduledPublishTime', '>=', earlierTimestamp)
    // .where('scheduledPublishTime', '<=', nowTimestamp);
    const snapshot = await query.get();

    const posts = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        const hydrated = await hydratePostUrls(storage, data, ttlMs);
        return { id: doc.id, ...hydrated };
      })
    );

    const uniqueAccountIds = Array.from(
      new Set(
        posts
          .flatMap((p) => (Array.isArray(p.accountIds) ? p.accountIds : []))
          .filter((id) => typeof id === 'string' && id.trim().length > 0)
      )
    );

    let accountById = new Map();
    if (uniqueAccountIds.length > 0) {
      const refs = uniqueAccountIds.map((id) => db.collection('platform_accounts').doc(id));
      const snaps = await db.getAll(...refs);
      snaps.forEach((snap) => {
        if (snap.exists) {
          accountById.set(snap.id, { id: snap.id, ...snap.data() });
        }
      });
    }

    const postsWithAccounts = posts.map((post) => {
      const accountIds = Array.isArray(post.accountIds) ? post.accountIds : [];
      const accounts = accountIds.map((id) => accountById.get(id)).filter(Boolean);
      return { ...post, accounts };
    });

    const postsWithUploads = await Promise.all(
      postsWithAccounts.map(async (post) => {
        const accounts = Array.isArray(post.accounts) ? post.accounts : [];

        const accountUploadResults = await Promise.all(
          accounts.map(async (account) => {
            if (!account || typeof account !== 'object') return { account, upload: null };
            if (account.platform === 'Instagram') {
              const result = await uploadToInstagram(post, account);
              return {
                account,
                upload: { accountId: account.id, ...result }
              };
            } else if (account.platform === 'Facebook') {
              const result = await uploadToFacebook(post, account);
              return {
                account,
                upload: { accountId: account.id, ...result }
              };
            }
            return { account, upload: null };
          })
        );

        const nextAccounts = accountUploadResults.map(({ account, upload }) => {
          if (!upload) return account;
          return { ...account, upload };
        });

        const nextPlatformStatuses =
          post.platformStatuses && typeof post.platformStatuses === 'object' ? { ...post.platformStatuses } : {};

        accountUploadResults.forEach(({ upload }) => {
          const accountId = upload && upload.accountId;
          if (!accountId) return;
          const existing =
            nextPlatformStatuses[accountId] && typeof nextPlatformStatuses[accountId] === 'object'
              ? nextPlatformStatuses[accountId]
              : {};
          nextPlatformStatuses[accountId] = { ...existing, ...upload };
        });
        delete post.accounts;
        // update properties in db
        const docRef = db.collection("posts").doc(post.id);
        // Update only the specific field
        await docRef.update({
          platformStatuses: nextPlatformStatuses,
          status: 'Published'
        });

        console.log(`Updated post for id = ${post.id}`);

        return { ...post, platformStatuses: nextPlatformStatuses };
      })
    );

    res.json({ count: postsWithUploads.length, posts: postsWithUploads });
  } catch (err) {
    res.status(500).json({ error: 'Internal error', details: String(err && err.message ? err.message : err) });
  }
}

module.exports = {
  uploadContentHandler
};
