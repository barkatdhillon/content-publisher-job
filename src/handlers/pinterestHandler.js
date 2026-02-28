const axios = require('axios');
const { setTimeout: sleep } = require("timers/promises");

const instagramAPIUrl = 'https://graph.facebook.com/v24.0'

const mediaTypes = {'Image': 'IMAGE', 'Video': 'VIDEO', 'Reel': 'REELS', 'Carousel': 'CAROUSEL'}


async function publishToPinterest(post, account) {
  const baseUrl = `${instagramAPIUrl}/${account.ac_id}`;
  const accessToken = account.authorizationKey;
  const mediaType = mediaTypes[post.type] || 'IMAGE';

  if (!instagramAPIUrl || !accessToken) {
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
    var res = {status: 'Uploaded'}
    switch(mediaType){
      case 'IMAGE':
        const imageResponse = await axios.post(baseUrl + '/media', {
            image_url: post.media[0].signedUrl,
            caption: post.caption || '',
            media_type: mediaType,
            access_token: accessToken
          });
        res.creation_id = imageResponse.data.id;
          break;

      case 'VIDEO':
        const videoResponse = await axios.post(baseUrl + '/media', {
            video_url: post.media[0].signedUrl,
            caption: post.caption || '',
            media_type: mediaType,
            access_token: accessToken
          });
          res.creation_id = videoResponse.data.id;
          break;

      case 'REELS':
        const reelResponse = await axios.post(baseUrl + '/media', {
            video_url: post.media[0].signedUrl,
            caption: post.caption || '',
            media_type: mediaType,
            access_token: accessToken
          });
          res.creation_id = reelResponse.data.id;
          break;

      case 'CAROUSEL':
        const containerIds = [];
        for (const med of post.media) {
          const payload = {
            caption: post.caption || '',
            is_carousel_item: true,
            access_token: accessToken
          }
          if(med.mediaType === 'Video') {
            payload.media_type = "VIDEO";
            payload.video_url = med.signedUrl;
          } else {
            payload.media_type = "IMAGE";
            payload.image_url = med.signedUrl;
          }
          const itemResponse = await axios.post(baseUrl + '/media', payload);
          await waitUntilFinished(itemResponse.data.id, accessToken);
          containerIds.push(itemResponse.data.id);
        }
        const carouselResponse = await axios.post(baseUrl + '/media', {
            caption: post.caption || '',
            media_type: mediaType,
            children: containerIds,
            access_token: accessToken
          });
        res.creation_id = carouselResponse.data.id;
        break;

      default:
        return {
          ok: false,
          error: 'Invalid media type'
        };
    }
    // wait for container to be ready
    await waitUntilFinished(res.creation_id, accessToken);

    const publishResponse = await axios.post(baseUrl + `/media_publish`,
      {
        creation_id: res.creation_id,
        access_token: accessToken
      }
    );

    return {status: 'Published', publish_id: publishResponse.data.id}; 
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
  publishToPinterest
};
