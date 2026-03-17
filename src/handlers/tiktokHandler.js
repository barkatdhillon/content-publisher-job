const axios = require('axios');
const {setTimeout: sleep} = require("timers/promises");
const {Timestamp} = require("firebase-admin/firestore");

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
        console.log(response.data)
        return response.data; // contains access_token and refresh_token
    } catch (error) {
        // Log the specific error to see if it's still 'Janus' or something else
        console.error("TikTok API Detail:", error.response?.data || error.message);
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
        console.error("TikTok API Detail:", error.response?.data || error.message);
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
                    console.log(`Targeting Bucket: ${bucketName}, Key: ${objectKey}`);

                    const bucket = storage.bucket(bucketName);
                    const file = bucket.file(objectKey);

                    // 1. Get File Metadata (Required for TikTok byte-range headers)
                    const [metadata] = await file.getMetadata();
                    const fileSize = parseInt(metadata.size);

                    // --- 3. REGISTER WITH PINTEREST ---
                    console.log("Registering video with TikTok...");
                    const registerRes = await axios.post(
                        `${tiktokAPIUrl}/post/publish/video/init/`,
                        {
                                // post_info: {
                                //     title: post.postText,
                                    // privacy_level: "SELF_ONLY", //"PUBLIC_TO_EVERYONE"
                                // },
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

                    console.log(`Successfully published ${objectKey}. ID: ${publish_id}`);
                    return publish_id;

                    // --- 5. POLL FOR SUCCESS (Better than a static timeout) ---
                    console.log("Waiting for Pinterest to process the video...");
                    let isReady = false;
                    while (!isReady) {
                        const statusRes = await axios.get(`${tiktokAPIUrl}/media/${media_id}`, {
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
                        `${tiktokAPIUrl}/pins`,
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
                    if (error.response) {
                        // This will tell you if it's "scope_not_found" or "permission_denied"
                        console.error("TikTok 403 Details:", JSON.stringify(error.response.data, null, 2));
                    }

                    res.status = 'failed';
                    res.message = error.response?.data || error.message;
                    console.error("Workflow failed:", error.response?.data || error.message);
                    throw error;
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

                const carouselResponse = await axios.post(`${tiktokAPIUrl}/pins`, payload, {
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
        console.error('TikTok publish error:', {
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

module.exports = {
    publishToTikTok,
    refreshTikTokToken,
    generateTikTokAccessTokens
};