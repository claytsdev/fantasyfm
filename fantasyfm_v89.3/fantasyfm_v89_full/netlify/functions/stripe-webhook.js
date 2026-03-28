exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify Stripe signature
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    // Simple signature verification without the Stripe library
    const crypto = require('crypto');
    const payload = event.body;
    const elements = sig.split(',');
    const timestamp = elements.find(e => e.startsWith('t=')).split('=')[1];
    const signatures = elements.filter(e => e.startsWith('v1=')).map(e => e.split('=')[1]);
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
    if (!signatures.includes(expectedSig)) {
      return { statusCode: 400, body: 'Invalid signature' };
    }
    stripeEvent = JSON.parse(payload);
  } catch (err) {
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  const sbHeaders = {
    'Content-Type': 'application/json',
    'apikey': process.env.SUPABASE_SECRET_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    'Prefer': 'return=representation'
  };
  const sbBase = `${process.env.SUPABASE_URL}/rest/v1`;

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const email = session.customer_email || session.customer_details?.email;
    if (!email) return { statusCode: 200, body: 'No email found' };

    // Generate a random password
    const password = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-4).toUpperCase() + '!';

    // Create Supabase auth user
    const authR = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
      body: JSON.stringify({ email, password, email_confirm: true })
    });
    const authData = await authR.json();

    // Add to streamers table (upsert)
    const existing = await fetch(`${sbBase}/streamers?email=eq.${encodeURIComponent(email)}`, { headers: sbHeaders });
    const existingData = await existing.json();

    if (existingData.length > 0) {
      await fetch(`${sbBase}/streamers?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH', headers: sbHeaders,
        body: JSON.stringify({ access_type: 'paid', expires_at: null, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription })
      });
    } else {
      await fetch(`${sbBase}/streamers`, {
        method: 'POST', headers: sbHeaders,
        body: JSON.stringify({ email, access_type: 'paid', expires_at: null, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription })
      });
    }

    // Send welcome email via Supabase
    await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${authData.id}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_SECRET_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
      body: JSON.stringify({ type: 'signup' })
    });
  }

  if (stripeEvent.type === 'customer.subscription.deleted') {
    const subscription = stripeEvent.data.object;
    // Find streamer by subscription ID and remove access
    await fetch(`${sbBase}/streamers?stripe_subscription_id=eq.${subscription.id}`, {
      method: 'PATCH', headers: sbHeaders,
      body: JSON.stringify({ access_type: 'cancelled', expires_at: new Date().toISOString() })
    });
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
