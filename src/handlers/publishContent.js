const { parseCsvEnv, applyStatusFilter } = require('../utils/firestoreFilters');
const { hydratePostUrls } = require('../services/postUrlHydration');
const { uploadToInstagram } = require('./instagramHandler');
const { uploadToFacebook } = require('./facebookHandler');
const { publishToPinterest, fetchPinterestBoards, refreshPinterestToken, generatePinAccessTokens } = require('./pinterestHandler');
const { publishToTikTok, refreshTikTokToken, generateTikTokAccessTokens } = require('./tiktokHandler');
const { publishToYouTube } = require('./youtubeHandler')
const { Timestamp } = require('firebase-admin/firestore');

async function publishContentHandler({ db, storage }, req, res) {
  try {
    const ttlMs = 60 * 60 * 1000;

    // Only query posts with 'Scheduled' status to prevent duplicate processing
    // Posts marked as 'Publishing' or 'Published' will be excluded
    const statuses = parseCsvEnv('UPLOAD_STATUSES', ['Scheduled']);
    // Time range
    const now = new Date();
    // const istTime = new Date(
      // now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    // );
    const fifteenMinutesAgo = new Date(now.getTime() - 16 * 60 * 1000);

    // Convert to Firestore Timestamp
    const nowTimestamp = Timestamp.fromDate(now);
    const earlierTimestamp = Timestamp.fromDate(fifteenMinutesAgo);

    let query = db.collection('posts');
    query = applyStatusFilter(query, statuses);
    query = query
    .where('scheduledPublishTime', '>=', earlierTimestamp)
    .where('scheduledPublishTime', '<=', nowTimestamp);
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

    // Immediately mark posts as 'Publishing' to prevent duplicate processing
    const publishingUpdates = posts.map(post => {
      const docRef = db.collection('posts').doc(post.id);
      return docRef.update({ status: 'Publishing' });
    });
    await Promise.all(publishingUpdates);
    console.log(`Marked ${posts.length} posts as 'Publishing'`);

    const postsWithUploads = await Promise.all(
      postsWithAccounts.map(async (post) => {
        const accounts = Array.isArray(post.accounts) ? post.accounts : [];

        const accountUploadResults = await Promise.all(
          accounts.map(async (account) => {
            if (!account || typeof account !== 'object') return { account, upload: null };
            
            // IDEMPOTENCY CHECK: Skip if already published for this account
            const existingStatus = post.platformStatuses && post.platformStatuses[account.id];
            if (existingStatus && existingStatus.status === 'Published') {
              console.log(`Skipping ${account.platform} account ${account.id} - already published`);
              return { account, upload: existingStatus };
            }
            
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
            } else if (account.platform === 'Pinterest') {
                const result = await publishToPinterest(post, account, storage);
                return {
                    account,
                    upload: { accountId: account.id, ...result }
                };
            } else if (account.platform === 'YouTube') {
                const result = await publishToYouTube(post, account, storage);
                return {
                    account,
                    upload: { accountId: account.id, ...result }
                };
            } else if (account.platform === 'TikTok') {
                const result = await publishToTikTok(post, account, storage, db);
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
        
        // Determine final status: 'Published' if all succeeded, 'Failed' if any failed
        const allSucceeded = accountUploadResults.every(({ upload }) => 
          upload && (upload.status === 'Published' || upload.status === 'Uploaded')
        );
        const finalStatus = allSucceeded ? 'Published' : 'Failed';
        
        // Use transaction for atomic update to prevent race conditions
        const docRef = db.collection("posts").doc(post.id);
        try {
          await db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef);
            if (!doc.exists) {
              throw new Error(`Post ${post.id} not found`);
            }
            
            // Only update if status is still 'Publishing' (not already updated by another process)
            const currentStatus = doc.data().status;
            if (currentStatus === 'Publishing') {
              transaction.update(docRef, {
                platformStatuses: nextPlatformStatuses,
                status: finalStatus,
                lastUpdated: Timestamp.now()
              });
            } else {
              console.log(`Post ${post.id} status changed to ${currentStatus} - skipping update`);
            }
          });
          
          console.log(`Updated post ${post.id} to status: ${finalStatus}`);
        } catch (error) {
          console.error(`Transaction failed for post ${post.id}:`, error);
          // Revert to Scheduled on transaction failure
          await docRef.update({ status: 'Scheduled' });
          throw error;
        }

        return { ...post, platformStatuses: nextPlatformStatuses, status: finalStatus };
      })
    );

    res.json({ count: postsWithUploads.length, posts: postsWithUploads });
  } catch (err) {
    res.status(500).json({ error: 'Internal error', details: String(err && err.message ? err.message : err) });
  }
}

async function syncPinterestBoards(db, req, res) {
    try {
        // Get all Pinterest platform accounts
        const snapshot = await db.collection('platform_accounts')
            .where('platform', '==', 'Pinterest')
            .get();

        if (snapshot.empty) {
            console.log('No Pinterest accounts found');
            return res.status(404).json({ ok: false, message: 'No Pinterest accounts found' });
        }

        const pinterestAccounts = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Fetch boards for each account and update
        const updatePromises = pinterestAccounts.map(async (account) => {
            try {
                const tokens = await refreshPinterestToken(account);
                await db.collection('platform_accounts').doc(account.id).update({
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    lastTokenSyncTime: Timestamp.now()
                });

                const boards = await fetchPinterestBoards(account);

                // Update the account document with boards list
                await db.collection('platform_accounts').doc(account.id).update({
                    boards: boards,
                    lastBoardsSyncTime: Timestamp.now()
                });

                return { accountId: account.id, success: true, boardsCount: boards.length };
            } catch (error) {
                console.error(`Error syncing boards for account ${account.id}:`, error);
                return { accountId: account.id, success: false, error: error.message };
            }
        });

        const results = await Promise.all(updatePromises);
        res.json({ ok: true, results });
    } catch (error) {
        console.error('Error in syncPinterestBoards:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
}

async function generatePinterestTokens(db, req, res) {
    try {
        // Get all Pinterest platform accounts with pinCode defined
        const snapshot = await db.collection('platform_accounts')
            .where('platform', '==', 'Pinterest')
            .get();

        if (snapshot.empty) {
            console.log('No Pinterest accounts found');
            return res.status(404).json({ ok: false, message: 'No Pinterest accounts found' });
        }

        // Filter accounts that have pinCode defined (not null/undefined)
        const pinterestAccounts = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(account => account.pinCode != null);

        if (pinterestAccounts.length === 0) {
            console.log('No Pinterest accounts with pinCode found');
            return res.status(404).json({ ok: false, message: 'No Pinterest accounts with pinCode found' });
        }

        // Generate tokens for each account
        const updatePromises = pinterestAccounts.map(async (account) => {
            try {
                const tokens = await generatePinAccessTokens(account);
                await db.collection('platform_accounts').doc(account.id).update({
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    lastTokenSyncTime: Timestamp.now()
                });

                return { accountId: account.id, success: true };
            } catch (error) {
                console.error(`Error generating tokens for account ${account.id}:`, error);
                return { accountId: account.id, success: false, error: error.message };
            }
        });

        const results = await Promise.all(updatePromises);
        res.json({ ok: true, results });
    } catch (error) {
        console.error('Error in generatePinterestTokens:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
}

async function generateTikTokTokens(db, req, res) {
    try {
        // Get all Pinterest platform accounts with pinCode defined
        const snapshot = await db.collection('platform_accounts')
            .where('platform', '==', 'TikTok')
            .get();

        if (snapshot.empty) {
            console.log('No TikTok accounts found');
            return res.status(404).json({ ok: false, message: 'No TikTok accounts found' });
        }

        // Filter accounts that have pinCode defined (not null/undefined)
        const tikTokAccounts = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(account => account.code != null);

        if (tikTokAccounts.length === 0) {
            console.log('No TikTok accounts with code found');
            return res.status(404).json({ ok: false, message: 'No TikTok accounts with code found' });
        }

        // Generate tokens for each account
        const updatePromises = tikTokAccounts.map(async (account) => {
            try {
                const tokens = await generateTikTokAccessTokens(account);
                await db.collection('platform_accounts').doc(account.id).update({
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    lastTokenSyncTime: Timestamp.now()
                });

                return { accountId: account.id, success: true };
            } catch (error) {
                console.error(`Error generating tokens for account ${account.id}:`, error);
                return { accountId: account.id, success: false, error: error.message };
            }
        });

        const results = await Promise.all(updatePromises);
        res.json({ ok: true, results });
    } catch (error) {
        console.error('Error in generateTikTokTokens:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
}

module.exports = {
    publishContentHandler,
    syncPinterestBoards,
    generatePinterestTokens,
    generateTikTokTokens,
};
