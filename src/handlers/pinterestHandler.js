const axios = require('axios');
const {setTimeout: sleep} = require("timers/promises");

const pinterestAPIUrl = 'https://api.pinterest.com/v5';
const redirectUrl = 'https://content-publisher-8b3af.web.app/auth/callback';

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
        console.log(response.data)
        return response.data; // contains access_token and refresh_token
    } catch (error) {
        if (error.response) {
            // This will tell you if it's "invalid_grant" or "invalid_client"
            console.error('Pinterest Error Data:', error.response.data);
            console.error('Status:', error.response.status);
        } else {
            console.error('Error Message:', error.message);
        }
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
        console.error('Failed to refresh token:', error.response?.data || error.message);
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
                    console.log(`Targeting Bucket: ${bucketName}, Key: ${objectKey}`);

                    // --- 3. REGISTER WITH PINTEREST ---
                    console.log("Registering video with Pinterest...");
                    const registerRes = await axios.post(
                        `${pinterestAPIUrl}/media`,
                        { media_type: 'video' },
                        { headers: { 'Authorization': `Bearer ${accessToken}` } }
                    );

                    const { upload_url, upload_parameters, media_id } = registerRes.data;

                    console.log("Downloading video from GCS to Buffer...");
                    const [fileBuffer] = await storage.bucket(bucketName).file(objectKey).download();

                    // 2. Convert Buffer to a Blob (Standard Web format)
                    const { Blob } = require('buffer');
                    const fileBlob = new Blob([fileBuffer], { type: 'video/mp4' });

                    // 4. Use Native FormData (Standard in Node.js 18+)
                    // No 'require' needed, it's a global variable now
                    const form = new FormData();

                    Object.keys(upload_parameters).forEach(key => {
                        form.append(key, upload_parameters[key]);
                    });

                    // Append the Blob - standard FormData takes (key, value, filename)
                    form.append('file', fileBlob, 'video.mp4');

                    await axios.post(upload_url, form);

                    // --- 5. POLL FOR SUCCESS (Better than a static timeout) ---
                    console.log("Waiting for Pinterest to process the video...");
                    let isReady = false;
                    while (!isReady) {
                        const statusRes = await axios.get(`${pinterestAPIUrl}/media/${media_id}`, {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        });

                        if (statusRes.data.status === 'succeeded') {
                            isReady = true;
                            console.log("Video processing complete!");
                        } else if (statusRes.data.status === 'failed') {
                            throw new Error("Pinterest video processing failed.");
                        } else {
                            console.log("Still processing... checking again in 5s");
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }

                    // --- 6. CREATE THE PIN ---
                    const pinRes = await axios.post(
                        `${pinterestAPIUrl}/pins`,
                        {
                            board_id: boardId,
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

                    console.log("Success! Pin Created ID:", pinRes.data.id);
                    res.creation_id = pinRes.data.id;
                } catch (error) {
                    res.status = 'failed';
                    res.message = error.response?.data || error.message;
                    console.error("Workflow failed:", error.response?.data || error.message);
                }

                break;

            case 'carousel':

                // 3. Map the URLs into the required Pinterest "items" format
                const carouselItems = post.media.map(med => ({
                    url: med.signedUrl,
                    title: post.title,
                    description: post.caption
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

        return {status: 'Published', publish_id: res.creation_id};
    } catch (error) {
        console.error('Pinterest publish error:', {
            postId: post && post.id,
            postType: post && post.type,
            mediaType,
            boardId: post && post.pinBoard && post.pinBoard[account.id] && post.pinBoard[account.id].board
        });
        let er = {};
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Response Data:", error.response.data);
            er = error.response.data;
        } else if (error.request) {
            console.error("No response received");
            er = error.request;
        } else {
            console.error("Error:", error.message);
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
        console.error('Error fetching Pinterest boards:', error);
        throw error;
    }
}

module.exports = {
    publishToPinterest,
    fetchPinterestBoards,
    refreshPinterestToken,
    generatePinAccessTokens
};