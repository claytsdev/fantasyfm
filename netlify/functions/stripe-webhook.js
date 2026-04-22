// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events to activate/renew streamer subscriptions

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': process.env.SUPABASE_SECRET_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Prefer': 'return=representation'
});
const sbBase = () => `${process.env.SUPABASE_URL}/rest/v1`;

// Verify the Stripe webhook signature to ensure the request is genuine
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const encoder = new TextEncoder();
  const parts = sigHeader.split(',');
  const tPart = parts.find(p => p.startsWith('t='));
  const v1Part = parts.find(p => p.startsWith('v1='));
  if (!tPart || !v1Part) throw new Error('Invalid Stripe signature header');

  const timestamp = tPart.slice(2);
  const expectedSig = v1Part.slice(3);
  const payload = `${timestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computedSig = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedSig !== expectedSig) throw new Error('Stripe signature mismatch');

  // Reject webhooks older than 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
    throw new Error('Stripe webhook timestamp too old');
  }
}

// Grant paid access: set access_type='paid', expires_at = 31 days from now
async function grantPaidAccess(email) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 31);
  const expiresStr = expires.toISOString();

  // Check if streamer row exists
  const checkR = await fetch(
    `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}&select=id,access_type`,
    { headers: sbHeaders() }
  );
  const existing = await checkR.json();

  if (existing.length) {
    // Update existing row
    await fetch(
      `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ access_type: 'paid', expires_at: expiresStr })
      }
    );
    console.log(`Updated streamer to paid: ${email}, expires: ${expiresStr}`);
  } else {
    console.log(`No streamer row found for ${email} — they need to sign up first`);
  }
}

// Expire access when subscription is cancelled/unpaid
async function expireAccess(email) {
  await fetch(
    `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: sbHeaders(),
      body: JSON.stringify({ access_type: 'expired', expires_at: new Date().toISOString() })
    }
  );
  console.log(`Expired access for: ${email}`);
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  const sigHeader = event.headers['stripe-signature'];
  if (!sigHeader) {
    return { statusCode: 400, body: 'Missing Stripe signature' };
  }

  try {
    await verifyStripeSignature(event.body, sigHeader, webhookSecret);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook signature invalid: ${err.message}` };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Stripe event received:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {

      // ── Payment succeeded — grant/renew access ──────────────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        // Email is in customer_email (what we passed) or customer_details
        const email = session.customer_email || session.customer_details?.email;
        if (email) await grantPaidAccess(email);
        break;
      }

      // ── Subscription renewed monthly ────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        const email = invoice.customer_email;
        if (email && invoice.billing_reason !== 'subscription_create') {
          // subscription_create is already handled by checkout.session.completed
          await grantPaidAccess(email);
        }
        break;
      }

      // ── Subscription cancelled or payment failed ─────────────────────────
      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const obj = stripeEvent.data.object;
        // Need to fetch customer email from Stripe
        const custId = obj.customer;
        if (custId) {
          const custR = await fetch(`https://api.stripe.com/v1/customers/${custId}`, {
            headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
          });
          const cust = await custR.json();
          if (cust.email) await expireAccess(cust.email);
        }
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }
  } catch (err) {
    console.error('Error processing webhook:', err.message);
    return { statusCode: 500, body: err.message };
  }

  // Always return 200 to Stripe so it doesn't retry
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
