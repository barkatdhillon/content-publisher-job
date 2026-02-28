const axios = require('axios');
const {setTimeout: sleep} = require("timers/promises");

const pinterestAPIUrl = 'https://api.pinterest.com/v5';
const redirectUrl = 'http://localhost:8080/auth/callback';

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

async function waitUntilFinished(creationId, accessToken, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const response = await axios.get(`${pinterestAPIUrl}/pins/${creationId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
            if (response.data && response.data.id) {
                return true;
            }
        } catch (error) {
            if (i === maxAttempts - 1) throw error;
            await sleep(1000);
        }
    }
    return true;
}

async function publishToPinterest(post, account) {
    const accessToken = account.accessToken;
    const mediaType = mediaTypes[post.type] || 'image';
    const boardId = post.pinBoard[account.id].id;

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
                const videoPayload = {
                    board_id: boardId,
                    media_source: {
                        source_type: 'video_url',
                        url: post.media[0].signedUrl
                    },
                    description: post.caption || '',
                    title: post.title || ''
                };
                const videoResponse = await axios.post(`${pinterestAPIUrl}/pins`, videoPayload, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });
                res.creation_id = videoResponse.data.id;
                break;

            case 'carousel':
                const carouselMediaSources = post.media.map(med => ({
                    source_type: med.mediaType === 'Video' ? 'video_url' : 'image_url',
                    url: med.signedUrl
                }));

                const carouselPayload = {
                    board_id: boardId,
                    carousel_slots: carouselMediaSources.map(media => ({
                        media_source: media
                    })),
                    description: post.caption || '',
                    title: post.title || ''
                };
                const carouselResponse = await axios.post(`${pinterestAPIUrl}/pins`, carouselPayload, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
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

        // Wait for pin to be ready
        await waitUntilFinished(res.creation_id, accessToken);

        return {status: 'Published', publish_id: res.creation_id};
    } catch (error) {
        console.error(error);
        let er = {};
        if (error.response) {
            console.error("Status:", error.response.status);
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