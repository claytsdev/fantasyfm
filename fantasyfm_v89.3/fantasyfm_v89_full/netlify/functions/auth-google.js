exports.handler = async function(event) {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const APP_URL = process.env.APP_URL || 'https://fantasyfm.io';
  const REDIRECT_URI = `${APP_URL}/.netlify/functions/auth-google`;

  const params = new URLSearchParams(event.queryStringParameters || {});
  const code = params.get('code');
  const state = params.get('state');

  // Step 1: No code — redirect to Google
  if (!code) {
    const sessionCode = params.get('session') || '';
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', sessionCode);
    authUrl.searchParams.set('access_type', 'online');
    return { statusCode: 302, headers: { Location: authUrl.toString() }, body: '' };
  }

  // Step 2: Exchange code for token
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    // Get Google profile info
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    const username = profile.name;
    const userId = profile.id;
    const avatar = profile.picture || '';

    const returnUrl = new URL(APP_URL);
    returnUrl.searchParams.set('oauth', 'youtube');
    returnUrl.searchParams.set('username', username);
    returnUrl.searchParams.set('id', userId);
    returnUrl.searchParams.set('avatar', avatar);
    returnUrl.searchParams.set('session', state || '');
    return { statusCode: 302, headers: { Location: returnUrl.toString() }, body: '' };
  } catch (err) {
    return { statusCode: 302, headers: { Location: `${APP_URL}?oauth=error&msg=${encodeURIComponent(err.message)}` }, body: '' };
  }
};
