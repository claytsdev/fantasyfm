// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events to activate/renew streamer subscriptions

const sbHeaders = () => ({
  'Content-Type': 'application/json',
  'apikey': process.env.SUPABASE_SECRET_KEY,
  'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
  'Prefer': 'return=representation'
});
const sbBase = () => `${process.env.SUPABASE_URL}/rest/v1`;

// ── Utility ──────────────────────────────────────────────────────────────────

// Generate a random readable password (no ambiguous chars like 0/O/1/l)
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ── Stripe signature verification ────────────────────────────────────────────

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

// ── Supabase auth helpers ─────────────────────────────────────────────────────

// Check if a Supabase auth user exists for this email
// Uses the admin API (secret key) to list users and filter by email
async function getSupabaseAuthUser(email) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    }
  );
  const data = await r.json();
  // Returns { users: [...] }
  const users = data.users || [];
  return users.find(u => u.email?.toLowerCase() === email.toLowerCase()) || null;
}

// Create a new Supabase auth user with the given email and password
async function createSupabaseAuthUser(email, password) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SECRET_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true // Mark as confirmed so they can log in immediately
      })
    }
  );
  const data = await r.json();
  if (!data.id) {
    throw new Error(`Failed to create Supabase auth user: ${JSON.stringify(data)}`);
  }
  return data; // Returns the created user object
}

// ── Email sending via Resend ──────────────────────────────────────────────────

async function sendWelcomeEmail(email, password) {
  const loginUrl = process.env.APP_URL || 'https://fantasyfm.io';
  const html = `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #111;">
      <h2 style="color: #6366f1;">Welcome to FantasyFM! 🎉</h2>
      <p>Your subscription is active. Here are your login details:</p>
      <table style="width:100%; border-collapse:collapse; margin: 16px 0;">
        <tr>
          <td style="padding: 8px 12px; background:#f4f4f5; border-radius:4px; font-weight:bold;">Email</td>
          <td style="padding: 8px 12px;">${email}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px; background:#f4f4f5; border-radius:4px; font-weight:bold;">Password</td>
          <td style="padding: 8px 12px; font-family: monospace; font-size: 1.1em;">${password}</td>
        </tr>
      </table>
      <p>
        <a href="${loginUrl}" style="display:inline-block; background:#6366f1; color:#fff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold;">
          Log in to FantasyFM
        </a>
      </p>
      <p style="color:#666; font-size:0.9em;">
        You can change your password after logging in.<br>
        Your subscription renews monthly — you'll receive a reminder before any charge.
      </p>
      <p style="color:#999; font-size:0.8em;">FantasyFM · fantasyfm.io</p>
    </div>
  `;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: 'FantasyFM <welcome@fantasyfm.io>',
      to: [email],
      subject: 'Welcome to FantasyFM — your login details',
      html
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`Welcome email sent to ${email}`, data.id);
}

async function sendRenewalEmail(email) {
  const loginUrl = process.env.APP_URL || 'https://fantasyfm.io';
  const html = `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #111;">
      <h2 style="color: #6366f1;">FantasyFM — Access Renewed ✅</h2>
      <p>Your FantasyFM subscription has been renewed for another month.</p>
      <p>
        <a href="${loginUrl}" style="display:inline-block; background:#6366f1; color:#fff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold;">
          Go to FantasyFM
        </a>
      </p>
      <p style="color:#999; font-size:0.8em;">FantasyFM · fantasyfm.io</p>
    </div>
  `;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: 'FantasyFM <welcome@fantasyfm.io>',
      to: [email],
      subject: 'FantasyFM — subscription renewed',
      html
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  console.log(`Renewal email sent to ${email}`, data.id);
}

// ── Core access logic ─────────────────────────────────────────────────────────

// Called on checkout.session.completed — handles both new and returning streamers
async function handleNewCheckout(email) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 31);
  const expiresStr = expires.toISOString();

  // 1. Check streamers table
  const checkR = await fetch(
    `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}&select=id,access_type`,
    { headers: sbHeaders() }
  );
  const existing = await checkR.json();

  // 2. Check Supabase auth.users
  const authUser = await getSupabaseAuthUser(email);

  if (!authUser) {
    // ── BRAND NEW STREAMER ──────────────────────────────────────────────────
    console.log(`New streamer: ${email} — creating auth account`);

    const password = generatePassword();

    // Create auth user
    await createSupabaseAuthUser(email, password);

    if (existing.length) {
      // Streamer row exists (e.g. was on beta/waitlist) — just update it
      await fetch(
        `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ access_type: 'paid', expires_at: expiresStr })
        }
      );
    } else {
      // Insert fresh streamers row
      await fetch(
        `${sbBase()}/streamers`,
        {
          method: 'POST',
          headers: sbHeaders(),
          body: JSON.stringify({ email, access_type: 'paid', expires_at: expiresStr })
        }
      );
    }

    // Send welcome email with credentials
    await sendWelcomeEmail(email, password);
    console.log(`New streamer setup complete: ${email}, expires: ${expiresStr}`);

  } else {
    // ── RETURNING / EXISTING STREAMER ───────────────────────────────────────
    console.log(`Existing streamer: ${email} — renewing access`);

    if (existing.length) {
      await fetch(
        `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: sbHeaders(),
          body: JSON.stringify({ access_type: 'paid', expires_at: expiresStr })
        }
      );
    } else {
      // Auth user exists but no streamers row — insert one
      await fetch(
        `${sbBase()}/streamers`,
        {
          method: 'POST',
          headers: sbHeaders(),
          body: JSON.stringify({ email, access_type: 'paid', expires_at: expiresStr })
        }
      );
    }

    // Send renewal email (no password — they already have one)
    await sendRenewalEmail(email);
    console.log(`Access renewed: ${email}, expires: ${expiresStr}`);
  }
}

// Called on invoice.payment_succeeded (monthly renewal, not first payment)
async function grantPaidAccess(email) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 31);
  const expiresStr = expires.toISOString();

  const checkR = await fetch(
    `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}&select=id,access_type`,
    { headers: sbHeaders() }
  );
  const existing = await checkR.json();

  if (existing.length) {
    await fetch(
      `${sbBase()}/streamers?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: sbHeaders(),
        body: JSON.stringify({ access_type: 'paid', expires_at: expiresStr })
      }
    );
    console.log(`Renewed streamer to paid: ${email}, expires: ${expiresStr}`);
  } else {
    console.log(`No streamer row found for ${email} during renewal — skipping`);
  }

  // Send renewal email
  try {
    await sendRenewalEmail(email);
  } catch (emailErr) {
    // Don't fail the webhook over an email error
    console.error(`Renewal email failed for ${email}:`, emailErr.message);
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

// ── Handler ───────────────────────────────────────────────────────────────────

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

      // ── First payment / new checkout ─────────────────────────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const email = session.customer_email || session.customer_details?.email;
        if (email) await handleNewCheckout(email);
        break;
      }

      // ── Monthly renewal ──────────────────────────────────────────────────
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
