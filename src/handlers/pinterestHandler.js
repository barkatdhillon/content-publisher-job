const axios = require('axios');
const FormData = require('form-data');
const {setTimeout: sleep} = require("timers/promises");
const { createLogger } = require('../utils/logger');

const log = createLogger('PinterestHandler');

const pinterestAPIUrl = 'https://api.pinterest.com/v5';
const redirectUrl = 'https://planner.naturalpoonam.com/callback/pinterest';

const mediaTypes = {'Image': 'image', 'Video': 'video', 'Reel': 'video', 'Carousel': 'carousel'}

// https://www.pinterest.com/oauth/?client_id=1545991&redirect_uri=http://localhost:8080/auth/callback&response_type=code&scope=boards:read,pins:read

async function generatePinAccessTokens(account) {
    code = account.pinCode
    const auth = Buffer.from(`${account.ac_id}:${account.pin_secret_key}`).toString('base64');
    try {
        const response = await axios.post(`${pinterestAPIUrl}/oauth/token`,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUrl,
            }),
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        log.info('Generated Pinterest access tokens', { accountId: account.id });
        return response.data; // contains access_token and refresh_token
    } catch (error) {
        log.error('Failed to generate Pinterest access tokens', { accountId: account.id }, error);
    }
}

async function refreshPinterestToken(account) {
    // Base64 encode your credentials for the Basic Auth header
    const auth = Buffer.from(`${account.ac_id}:${account.pin_secret_key}`).toString('base64');

    try {
        const response = await axios.post(`${pinterestAPIUrl}/oauth/token`,
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: account.refreshToken,
            }),
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        return response.data;
    } catch (error) {
        log.error('Failed to refresh Pinterest token', { accountId: account.id }, error);
        throw new Error('Authentication expired. Please re-link your Pinterest account.');
    }
}

function parseGsUrl(gsUrl) {
    const parts = gsUrl.replace('gs://', '').split('/');
    const bucketName = parts.shift(); // First part is the bucket
    const objectKey = parts.join('/'); // Remaining parts are the path
    return { bucketName, objectKey };
}

async function publishToPinterest(post, account, storage) {
    const accessToken = account.accessToken;
    const mediaType = mediaTypes[post.type] || 'image';
    const boardId = post.pinBoard[account.id].board;

    if (!accessToken || !boardId) {
        return {
            ok: false,
            error: 'Missing accessToken or pinterest_board_id'
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
            case 'image':
                const imagePayload = {
                    board_id: boardId,
                    link: post.pinBoard[account.id].url,
                    media_source: {
                        source_type: 'image_url',
                        url: post.media[0].signedUrl
                    },
                    description: post.caption || '',
                    title: post.title || ''
                };
                const imageResponse = await axios.post(`${pinterestAPIUrl}/pins`, imagePayload, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });
                res.creation_id = imageResponse.data.id;
                break;

            case 'video':
                try {
                    // --- 2. PARSE THE GS URL ---
                    const { bucketName, objectKey } = parseGsUrl(post.media[0].gcsPath);
                    log.info('Targeting GCS object for Pinterest video upload', { postId: post.id, bucketName, objectKey });

                    // --- 3. REGISTER WITH PINTEREST ---
                    const registerRes = await axios.post(
                        `${pinterestAPIUrl}/media`,
                        { media_type: 'video' },
                        { headers: { 'Authorization': `Bearer ${accessToken}` } }
                    );

                    const { upload_url, upload_parameters, media_id } = registerRes.data;

                    // Pinterest's upload_url is a standard S3 presigned-POST endpoint,
                    // so we can stream the file straight from GCS instead of buffering
                    // the whole video in memory.
                    const file = storage.bucket(bucketName).file(objectKey);
                    const [metadata] = await file.getMetadata();
                    const fileSize = parseInt(metadata.size, 10);

                    log.info('Streaming video from GCS to Pinterest', { postId: post.id, mediaId: media_id, fileSize });
                    const form = new FormData();

                    Object.keys(upload_parameters).forEach(key => {
                        form.append(key, upload_parameters[key]);
                    });

                    form.append('file', file.createReadStream(), { filename: 'video.mp4', knownLength: fileSize });

                    await axios.post(upload_url, form, {
                        headers: {
                            ...form.getHeaders(),
                            'Content-Length': form.getLengthSync()
                        },
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    });

                    // --- 5. POLL FOR SUCCESS (Better than a static timeout) ---
                    let isReady = false;
                    while (!isReady) {
                        const statusRes = await axios.get(`${pinterestAPIUrl}/media/${media_id}`, {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        });

                        if (statusRes.data.status === 'succeeded') {
                            isReady = true;
                            log.info('Pinterest video processing complete', { postId: post.id, mediaId: media_id });
                        } else if (statusRes.data.status === 'failed') {
                            throw new Error("Pinterest video processing failed.");
                        } else {
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }

                    // --- 6. CREATE THE PIN ---
                    const pinRes = await axios.post(
                        `${pinterestAPIUrl}/pins`,
                        {
                            board_id: boardId,
                            link: post.pinBoard[account.id].url,
                            title: post.title,
                            description: post.caption,
                            media_source: {
                                source_type: "video_id",
                                media_id: media_id,
                                cover_image_key_frame_time: 1000
                            }
                        },
                        { headers: { 'Authorization': `Bearer ${accessToken}` } }
                    );

                    log.info('Pinterest video pin created', { postId: post.id, pinId: pinRes.data.id });
                    res.creation_id = pinRes.data.id;
                } catch (error) {
                    res.status = 'failed';
                    res.message = error.response?.data || error.message;
                    log.error('Pinterest video workflow failed', { postId: post.id, accountId: account.id }, error);
                }

                break;

            case 'carousel':

                // Pinterest carousels support a maximum of 5 images per pin
                const carouselItems = post.media.slice(0, 5).map(med => ({
                    url: med.signedUrl
                }));

                const payload = {
                    title: post.title,
                    description: post.caption,
                    board_id: boardId,
                    link: post.pinBoard[account.id].url,
                    media_source: {
                        source_type: "multiple_image_urls",
                        items: carouselItems
                    }
                };

                const carouselResponse = await axios.post(`${pinterestAPIUrl}/pins`, payload, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                });
                res.creation_id = carouselResponse.data.id;
                break;

            default:
                return {
                    ok: false,
                    error: 'Invalid media type'
                };
        }

        // The video case's inner try/catch swallows its own errors (to log
        // detailed context) and signals failure via res.status instead of
        // throwing - without this check, a failed video upload would fall
        // through and be reported as 'Published' with no publish_id.
        if (res.status === 'failed') {
            return { status: 'Failed', error: res.message };
        }

        return {status: 'Published', publish_id: res.creation_id};
    } catch (error) {
        const context = {
            postId: post && post.id,
            postType: post && post.type,
            accountId: account && account.id,
            mediaType,
            boardId: post && post.pinBoard && post.pinBoard[account.id] && post.pinBoard[account.id].board
        };
        let er = {};
        if (error.response) {
            log.error('Pinterest publish error - API response', context, error);
            er = error.response.data;
        } else if (error.request) {
            log.error('Pinterest publish error - no response received', context, error);
            er = 'No response received from Pinterest';
        } else {
            log.error('Pinterest publish error', context, error);
            er = error.message;
        }
        return {status: 'Failed', error: er};
    }
}

async function fetchPinterestBoards(account) {

    try {
        const response = await axios.get(`${pinterestAPIUrl}/boards`, {
            headers: {
                'Authorization': `Bearer ${account.accessToken}`
            },
            params: {
                page_size: 100
            }
        });

        const boards = response.data.items || [];
        return boards.map(board => ({
            id: board.id,
            name: board.name
        }));
    } catch (error) {
        log.error('Error fetching Pinterest boards', { accountId: account.id }, error);
        throw error;
    }
}

module.exports = {
    publishToPinterest,
    fetchPinterestBoards,
    refreshPinterestToken,
    generatePinAccessTokens
};