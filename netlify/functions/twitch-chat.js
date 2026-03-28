// Twitch Chat Bot - sends messages to a streamer's channel
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { channel, message } = body;

    if (!channel || !message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing channel or message' }) };
    }

    const BOT_TOKEN = process.env.TWITCH_BOT_TOKEN;
    const BOT_CLIENT_ID = process.env.TWITCH_BOT_CLIENT_ID;
    const BOT_USERNAME = 'fantasyfmbot';

    // Get broadcaster ID
    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`, {
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Client-Id': BOT_CLIENT_ID
      }
    });
    const userData = await userRes.json();
    if (!userData.data || !userData.data.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Channel not found' }) };
    }
    const broadcasterId = userData.data[0].id;

    // Get bot user ID
    const botRes = await fetch(`https://api.twitch.tv/helix/users?login=${BOT_USERNAME}`, {
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Client-Id': BOT_CLIENT_ID
      }
    });
    const botData = await botRes.json();
    const botId = botData.data[0].id;

    // Send chat message via Twitch API
    const msgRes = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Client-Id': BOT_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: botId,
        message: message
      })
    });

    const msgData = await msgRes.json();

    if (msgData.error) {
      return { statusCode: 200, body: JSON.stringify({ error: msgData.message || 'Failed to send message' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
