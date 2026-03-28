exports.handler = async function(event) {
  const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
  const APP_URL = process.env.APP_URL || 'https://fantasyfm.io';
  const REDIRECT_URI = `${APP_URL}/.netlify/functions/auth-twitch`;

  const params = new URLSearchParams(event.queryStringParameters || {});
  const code = params.get('code');
  const state = params.get('state'); // session code passed through

  // Step 1: No code yet — redirect to Twitch
  if (!code) {
    const sessionCode = params.get('session') || '';
    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id', TWITCH_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'user:read:email');
    authUrl.searchParams.set('state', sessionCode);
    return { statusCode: 302, headers: { Location: authUrl.toString() }, body: '' };
  }

  // Step 2: Exchange code for token
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    // Get user info
    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    const userData = await userRes.json();
    const user = userData.data[0];

    // Redirect back to app with user info
    const returnUrl = new URL(APP_URL);
    returnUrl.searchParams.set('oauth', 'twitch');
    returnUrl.searchParams.set('username', user.display_name);
    returnUrl.searchParams.set('id', user.id);
    returnUrl.searchParams.set('avatar', user.profile_image_url || '');
    returnUrl.searchParams.set('session', state || '');
    return { statusCode: 302, headers: { Location: returnUrl.toString() }, body: '' };
  } catch (err) {
    return { statusCode: 302, headers: { Location: `${APP_URL}?oauth=error&msg=${encodeURIComponent(err.message)}` }, body: '' };
  }
};
