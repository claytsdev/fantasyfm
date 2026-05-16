// netlify/functions/oauth-config.js
// Returns OAuth client IDs from environment variables.
// This avoids Netlify's secret scanner blocking deploys when client IDs
// are hardcoded in committed source files.
exports.handler = async function(event) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify({
      twitch_client_id: process.env.TWITCH_CLIENT_ID || '',
      youtube_client_id: process.env.YOUTUBE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    }),
  };
};
