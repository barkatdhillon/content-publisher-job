const axios = require('axios');
const {setTimeout: sleep} = require("timers/promises");
const {Timestamp} = require("firebase-admin/firestore");
const { createLogger } = require('../utils/logger');

const log = createLogger('TikTokHandler');

const tiktokAPIUrl = 'https://open.tiktokapis.com/v2';
const redirectUrl = 'https://planner.naturalpoonam.com/callback/tiktok';

const mediaTypes = {'Image': 'carousel', 'Video': 'video', 'Reel': 'video', 'Carousel': 'carousel'}

// https://www.pinterest.com/oauth/?client_id=1545991&redirect_uri=http://localhost:8080/auth/callback&response_type=code&scope=boards:read,pins:read

async function generateTikTokAccessTokens(account) {
    try {
        const response = await axios.post(`${tiktokAPIUrl}/oauth/token/`,
            new URLSearchParams({
                grant_type: 'authorization_code',
                client_key: account.clientKey,
                client_secret: account.clientSecret,
                code: account.code,
                redirect_uri: redirectUrl,
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cache-Control': 'no-cache'
                }
            }
        );
        if(response.data.error){
            throw new Error(response.data.error_description);
        }
        log.info('Generated TikTok access tokens', { accountId: account.id });
        return response.data; // contains access_token and refresh_token
    } catch (error) {
        // Log the specific error to see if it's still 'Janus' or something else
        log.error('Failed to generate TikTok access tokens', { accountId: account.id }, error);
        throw error;
    }
}

async function refreshTikTokToken(account, db) {
    try {
        const response = await axios.post(`${tiktokAPIUrl}/oauth/token/`,
            new URLSearchParams({
                grant_type: 'refresh_token',
                client_key: account.clientKey,
                client_secret: account.clientSecret,
                refresh_token: account.refreshToken,
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cache-Control': 'no-cache'
                }
            }
        );
        if(response.data.error){
            throw new Error(response.data.error_description);
        }
        const tokens = response.data; // contains access_token and refresh_token
        await db.collection('platform_accounts').doc(account.id).update({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            lastTokenSyncTime: Timestamp.now()
        });
        return tokens.access_token;
    } catch (error) {
        // Log the specific error to see if it's still 'Janus' or something else
        log.error('Failed to refresh TikTok token', { accountId: account.id }, error);
        throw error;
    }
}

function parseGsUrl(gsUrl) {
    const parts = gsUrl.replace('gs://', '').split('/');
    const bucketName = parts.shift(); // First part is the bucket
    const objectKey = parts.join('/'); // Remaining parts are the path
    return { bucketName, objectKey };
}

async function publishToTikTok(post, account, storage, db) {
    const accessToken = await refreshTikTokToken(account, db)

    const mediaType = mediaTypes[post.type] || 'video';
    post.postText = `${post?.title || ''} ${post?.caption || ''}`.trim();

    if (!accessToken) {
        return {
            ok: false,
            error: 'Missing accessToken'
        };
    }

    if (!post || !Array.isArray(post.media) || !post.media[0] || !post.media[0].signedUrl) {
        return {
            ok: false,
            error: 'Missing Media URL'
        };
    }

    try {
        var res = {status: 'Uploading'};

        switch (mediaType) {

            case 'video':
                try {

                    // --- 2. PARSE THE GS URL ---
                    const { bucketName, objectKey } = parseGsUrl(post.media[0].gcsPath);
                    log.info('Targeting GCS object for TikTok video upload', { postId: post.id, bucketName, objectKey });

                    const bucket = storage.bucket(bucketName);
                    const file = bucket.file(objectKey);

                    // 1. Get File Metadata (Required for TikTok byte-range headers)
                    const [metadata] = await file.getMetadata();
                    const fileSize = parseInt(metadata.size);

                    // --- 3. REGISTER WITH TIKTOK ---
                    const registerRes = await axios.post(
                        `${tiktokAPIUrl}/post/publish/video/init/`,
                        {
                                source_info: {
                                    source: "FILE_UPLOAD",
                                    video_size: fileSize,
                                    chunk_size: fileSize,
                                    total_chunk_count: 1
                                }
                            },
                        { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
                    );

                    const { upload_url, publish_id } = registerRes.data;

                    // 3. Stream from GCS directly to TikTok (Step 2)
                    // We use file.createReadStream() to stream the data without loading it into memory
                    await axios({
                        method: 'put',
                        url: upload_url,
                        data: file.createReadStream(),
                        headers: {
                            'Content-Type': 'video/mp4',
                            'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
                            'Content-Length': fileSize
                        },
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    });

                    log.info('TikTok video published', { postId: post.id, publishId: publish_id });
                    res.creation_id = publish_id;
                } catch (error) {
                    if (error.response) {
                        // This will tell you if it's "scope_not_found" or "permission_denied"
                        log.error('TikTok video workflow failed - API response', { postId: post.id, accountId: account.id }, error);
                    } else {
                        log.error('TikTok video workflow failed', { postId: post.id, accountId: account.id }, error);
                    }

                    res.status = 'failed';
                    res.message = error.response?.data || error.message;
                    throw error;
                }

                break;

            default:
                return {
                    ok: false,
                    error: 'Invalid media type'
                };
        }

        return {status: 'Published', publish_id: res.creation_id};
    } catch (error) {
        const context = { postId: post && post.id, postType: post && post.type, accountId: account && account.id, mediaType };
        let er = {};
        if (error.response) {
            log.error('TikTok publish error - API response', context, error);
            er = error.response.data;
        } else if (error.request) {
            log.error('TikTok publish error - no response received', context, error);
            er = 'No response received from TikTok';
        } else {
            log.error('TikTok publish error', context, error);
            er = error.message;
        }
        return {status: 'Failed', error: er};
    }
}

module.exports = {
    publishToTikTok,
    refreshTikTokToken,
    generateTikTokAccessTokens
};