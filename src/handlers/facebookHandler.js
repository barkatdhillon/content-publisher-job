const axios = require('axios');
const { setTimeout: sleep } = require("timers/promises");
const { Storage } = require("@google-cloud/storage");
const storage = new Storage();

const facebookAPIUrl = 'https://graph.facebook.com/v24.0'

const mediaTypes = {'Image': 'IMAGE', 'Video': 'VIDEO', 'Reel': 'REELS', 'Carousel': 'CAROUSEL'}

async function waitUntilFinished(videoId, token, maxAttempts = 20) {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const res = await axios.get(
      `${facebookAPIUrl}/${videoId}`,
      {
        params: {
          fields: "status_code",
          access_token: token
        }
      }
    );

    const status = res.data.status_code;

    if (status === "FINISHED") {
      return true;
    }

    if (status === "ERROR") {
      throw new Error(`Media processing failed: ${videoId}`);
    }

    attempts++;
    console.log(`Sleep for 3 seconds - ${attempts} attempts`);
    await sleep(3000); // wait 3 seconds before checking again
  }

  throw new Error("Media processing timeout");
}

async function uploadPhoto(baseUrl, pageToken, imageUrl) {
  const res = await axios.post(`${baseUrl}/photos`, {
    url: imageUrl,
    published: false,
    temporary: true,
    access_token: pageToken
  });

  return res.data.id;
}

async function uploadVideo(baseUrl, pageToken, videoUrl) {
  const res = await axios.post(`${baseUrl}/videos`, {
    file_url: videoUrl,
    published: false,
    access_token: pageToken
  });

  return res.data.id;
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
            mediaIds.push({ media_fbid: photo.data.id });
        }

        // 2. Attach them to a Feed Post
        const postResponse = await axios.post(`${baseUrl}/feed`, {
            message: post.caption || '',
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

async function uploadToFacebook(post, account) {
  const baseUrl = `${facebookAPIUrl}/${account.fb_id}`;
  const accessToken = account.authorizationKey;
  const mediaType = mediaTypes[post.type] || 'IMAGE';

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

    switch(mediaType){
      case 'IMAGE':
        const imageResponse = await axios.post(baseUrl + '/photos', {
            url: post.media[0].signedUrl,
            caption: post.caption || '',
            access_token: pageAccessToken
          });
        res.creation_id = imageResponse.data.id;
          break;

      case 'VIDEO':
        const videoResponse = await axios.post(baseUrl + '/videos', {
            file_url: post.media[0].signedUrl,
            description: post.caption || '',
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
        const { video_id, upload_url} = startRes.data;
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
              description: post.caption || ''
            }
          }
        );
        console.log("Reel created:", reelResponse);
        res.creation_id = video_id;
        break;

      case 'CAROUSEL':
        res.creation_id = await uploadToMyPage(baseUrl, pageAccessToken, post);
        break;

      default:
        return {
          ok: false,
          error: 'Invalid media type'
        };
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
  uploadToFacebook
};
