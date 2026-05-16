const axios = require('axios');
const {setTimeout: sleep} = require("timers/promises");

const facebookAPIUrl = 'https://graph.facebook.com/v24.0'

const mediaTypes = {'Image': 'IMAGE', 'Video': 'VIDEO', 'Reel': 'REELS', 'Carousel': 'CAROUSEL', 'Story': 'STORY'}

function normalizeFirstComment(post) {
    const raw = post && typeof post === 'object' ? post.firstComment : null;
    if (typeof raw !== 'string') return '';
    return raw.trim();
}

async function uploadToMyPage(baseUrl, pageAccessToken, post) {

    try {
        // 1. Upload Photos as "Temporary" to the Page
        const mediaIds = [];
        for (const med of post.media) {
            const photo = await axios.post(`${baseUrl}/photos`, {
                url: med.signedUrl,
                published: false, // Don't post yet
                temporary: true,  // Important for personal apps
                access_token: pageAccessToken
            });
            mediaIds.push({media_fbid: photo.data.id});
        }

        // 2. Attach them to a Feed Post
        const postResponse = await axios.post(`${baseUrl}/feed`, {
            message: post.postText,
            attached_media: mediaIds, // No JSON.stringify needed with Axios
            access_token: pageAccessToken
        });

        console.log("Success! Post ID:", postResponse.data.id);
        return postResponse.data.id;
    } catch (err) {
        // This will print the EXACT reason it fails (e.g. missing scope)
        console.error("Failed:", err.response?.data || err.message);
        throw err;
    }
}

async function publishToFacebook(post, account) {
    const baseUrl = `${facebookAPIUrl}/${account.ac_id}`;
    const accessToken = account.authorizationKey;
    const mediaType = mediaTypes[post.type] || 'IMAGE';
    post.postText = `${post?.title || ''} ${post?.caption || ''}`.trim();

    if (!facebookAPIUrl || !accessToken) {
        return {
            ok: false,
            error: 'Missing instagramAPIUrl or INSTAGRAM_ACCESS_TOKEN'
        };
    }

    if (!post || !Array.isArray(post.media) || !post.media[0] || !post.media[0].signedUrl) {
        return {
            ok: false,
            error: 'Missing Media URL'
        };
    }
    try {
        var res = {status: 'Published'}
        const getPageTokenUrl = `${baseUrl}?fields=access_token&access_token=${accessToken}`;
        const tokenResponse = await axios.get(getPageTokenUrl);
        const pageAccessToken = tokenResponse.data.access_token;

        const firstComment = normalizeFirstComment(post);

        switch (mediaType) {
            case 'IMAGE':
                const imageResponse = await axios.post(baseUrl + '/photos', {
                    url: post.media[0].signedUrl,
                    caption: post.postText,
                    access_token: pageAccessToken
                });
                res.creation_id = imageResponse.data.id;
                break;

            case 'VIDEO':
                const videoResponse = await axios.post(baseUrl + '/videos', {
                    file_url: post.media[0].signedUrl,
                    description: post.postText,
                    title: post.title || '',
                    access_token: pageAccessToken
                });
                res.creation_id = videoResponse.data.id;
                break;

            case 'REELS':
                const startRes = await axios.post(baseUrl + '/video_reels', {
                        upload_phase: "start",
                        access_token: pageAccessToken
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
                const {video_id, upload_url} = startRes.data;
                console.log("Upload session started:", video_id);

                const uploadRes = await axios.post(upload_url, null, {
                    headers: {
                        Authorization: `OAuth ${pageAccessToken}`,
                        'file_url': post.media[0].signedUrl
                    }
                });

                console.log("Video uploaded successfully", uploadRes);

                const reelResponse = await axios.post(`${baseUrl}/video_reels`, null,
                    {
                        params: {
                            access_token: pageAccessToken,
                            video_id: video_id,
                            upload_phase: "finish",
                            video_state: "PUBLISHED",
                            description: post.postText
                        }
                    }
                );
                console.log("Reel created:", reelResponse);
                res.creation_id = video_id;
                break;

            case 'CAROUSEL':
                res.creation_id = await uploadToMyPage(baseUrl, pageAccessToken, post);
                break;

            case 'STORY':
                if (post.media[0] && post.media[0].mediaType === "image") {
                    console.log('Step 1: Uploading un-published target photo to page asset library...');

                    // 1. Upload photo to the page with published=false parameter
                    const uploadRes = await axios.post(baseUrl + '/photos', {
                        url: post.media[0].signedUrl,
                        published: false,
                        access_token: pageAccessToken
                    });

                    const photoId = uploadRes.data.id;
                    console.log(`Photo uploaded. Asset Photo ID: ${photoId}`);

                    // 2. Attach the generated photo ID to a new Story element
                    console.log('Step 2: Committing photo asset into Page Stories...');
                    const storyRes = await axios.post(baseUrl + '/photo_stories', {
                        photo_id: photoId,
                        access_token: pageAccessToken
                    });

                    res.creation_id = storyRes.data.post_id;

                } else if (post.media[0] && post.media[0].mediaType === "video") {
                    console.log('Step 1: Requesting upload endpoint for remote URL ingestion...');

                    const initResponse = await axios.post(baseUrl + '/video_stories', {
                        upload_phase: 'start',
                        access_token: pageAccessToken,
                    });

                    // Meta returns a special "upload_url" endpoint alongside the video_id
                    const { video_id, upload_url } = initResponse.data;
                    console.log(`Initialized. Video ID: ${video_id}`);
                    console.log(`Target Processing Gateway: ${upload_url}`);

                    // ==========================================
                    // STEP 2: TRIGGER THE META DOWNLOAD INGESTION
                    // ==========================================
                    console.log('Step 2: Pushing cloud target pointer to Meta gateway...');

                    // We make an authorized POST call directly to the target upload_url,
                    // passing the public video address in the custom file_url header.
                    const ingestResponse = await axios.post(upload_url, {}, {
                        headers: {
                            'Authorization': `OAuth ${pageAccessToken}`,
                            'file_url': post.media[0].signedUrl
                        }
                    });

                    console.log('Meta ingestion agent acknowledged file stream:', ingestResponse.data);

                    // ==========================================
                    // STEP 3: IMMEDIATELY COMMIT/FINISH THE STORY
                    // ==========================================
                    // Crucial: For remote file urls via stories, don't stall in a polling loop!
                    // Tell Meta to commit the upload tracking ID right away.
                    console.log('Step 3: Registering complete chunk status and publishing...');

                    const finishResponse = await axios.post(baseUrl + '/video_stories', {
                        upload_phase: 'finish',
                        video_id: video_id, // Link the asset ID explicitly
                        access_token: pageAccessToken,
                    });

                    console.log('Success! Finalizing token registration on feed.', finishResponse.data);
                    res.creation_id = finishResponse.data.post_id;
                }
                break;
            default:
                return {
                    ok: false,
                    error: 'Invalid media type'
                };
        }

        if (firstComment && res.creation_id) {
            try {
                const commentResponse = await axios.post(`${facebookAPIUrl}/${res.creation_id}/comments`, {
                    message: firstComment,
                    access_token: pageAccessToken
                });
                res.first_comment_id = commentResponse.data && commentResponse.data.id;
            } catch (commentErr) {
                console.error('Failed to add first comment:', commentErr.response?.data || commentErr.message);
                res.first_comment_error = commentErr.response?.data || commentErr.message;
            }
        }

        return res;
    } catch (error) {
        console.error(error);
        let er = {};
        if (error.response) {
            // Server responded with status 4xx/5xx
            console.error("Status:", error.response.status);
            er = error.response.data;

        } else if (error.request) {
            // No response received
            console.error("No response received");
            er = error.request
        } else {
            // Something else
            console.error("Error:", error.message);
            er = error.message;
        }
        return {status: 'Failed', error: er};
    }
}

module.exports = {
    uploadToFacebook: publishToFacebook
};
