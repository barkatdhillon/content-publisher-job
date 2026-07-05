const axios = require('axios');
const http = require('http');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const secretClient = new SecretManagerServiceClient();
const {setTimeout: sleep} = require("timers/promises");

const mediaTypes = {'Video': 'video', 'Reel': 'video'}

function normalizeFirstComment(post) {
    const raw = post && typeof post === 'object' ? post.firstComment : null;
    if (typeof raw !== 'string') return '';
    return raw.trim();
}

async function postAndBoostComment(videoId, commentText, oauth2Client) {
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    try {
        const threadResponse = await youtube.commentThreads.insert({
            part: 'snippet',
            requestBody: {
                snippet: {
                    videoId: videoId,
                    topLevelComment: {
                        snippet: {
                            textOriginal: commentText
                        }
                    }
                }
            }
        });

        const commentId = threadResponse.data && threadResponse.data.snippet && threadResponse.data.snippet.topLevelComment
            ? threadResponse.data.snippet.topLevelComment.id
            : null;

        if (commentId) {
            await youtube.comments.setRating({ id: commentId, rating: 'like' });
        }

        return commentId;
    } catch (error) {
        console.error('❌ Error in YouTube Workaround:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Fetches the secret value from the same Secret Manager
 * entries used by your Firebase Functions.
 */
async function getSecret(secretName) {
    const [version] = await secretClient.accessSecretVersion({
        name: `projects/content-publisher-8b3af/secrets/${secretName}/versions/latest`,
    });
    return version.payload.data.toString();
}

function parseGsUrl(gsUrl) {
    const parts = gsUrl.replace('gs://', '').split('/');
    const bucketName = parts.shift(); // First part is the bucket
    const fileName = parts.join('/'); // Remaining parts are the path
    return { bucketName, fileName };
}

async function publishToYouTube(post, account, storage) {
    const refreshToken = account.refresh_token;
    const mediaType = mediaTypes[post.type]

    const firstComment = normalizeFirstComment(post);

    if (!refreshToken || !mediaType) {
        return {
            ok: false,
            error: 'Missing accessToken or wrong media'
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

                    const { bucketName, fileName} = parseGsUrl(post.media[0].gcsPath);

                    if (!bucketName || !fileName) {
                        return res.status(400).send('Missing bucketName or fileName');
                    }

                    // 1. Load Credentials from Secrets
                    const clientId = account.clientId;
                    const clientSecret = await getSecret('YOUTUBE_CLIENT_SECRET');

                    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
                    oauth2Client.setCredentials({ refresh_token: refreshToken });

                    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

                    // 2. Setup GCS Stream
                    const gcsFile = storage.bucket(bucketName).file(fileName);
                    const videoStream = gcsFile.createReadStream();

                    console.log(`Starting upload for: ${fileName}`);

                    try {
                        // 3. Pipe to YouTube
                        const response = await youtube.videos.insert({
                            part: 'snippet,status',
                            requestBody: {
                                snippet: {
                                    title: post.title || 'New Upload',
                                    description: post.caption || 'Uploaded via Cloud Run',
                                    categoryId: '26', // How to and style
                                },
                                status: {
                                    privacyStatus: 'public', // Change to 'public' when ready
                                    selfDeclaredMadeForKids: false,
                                },
                            },
                            media: {
                                body: videoStream,
                            },
                        });
                        console.log('Upload successful! Video ID:', response.data.id);
                        res.creation_id = response.data.id;

                        if (firstComment && res.creation_id) {
                            const commentId = await postAndBoostComment(res.creation_id, firstComment, oauth2Client);
                            if (commentId) {
                                res.first_comment_id = commentId;
                            }
                        }
                    } finally {
                        // Ensure stream is always destroyed to prevent memory leaks
                        if (videoStream && !videoStream.destroyed) {
                            videoStream.destroy();
                        }
                    }
                } catch (error) {
                    return {
                        ok: false,
                        error: error.message
                    };
                }

                break;

            default:
                return {
                    ok: false,
                    error: 'Invalid media type'
                };
        }

        const out = {status: 'Published', publish_id: res.creation_id};
        if (res.first_comment_id) {
            out.first_comment_id = res.first_comment_id;
        }
        return out;
    } catch (error) {
        return {
            ok: false,
            error: error.message
        };
    }
}

module.exports = {
    publishToYouTube,
};