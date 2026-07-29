// pmensonp.com — Cloudflare Worker
// Serves the static site (index.html, career.html, story.html) via the ASSETS binding,
// and handles two dynamic routes for the Stripe + Printful auto-fulfillment pipeline:
//   GET  /create-checkout   -> starts a Stripe Checkout session, redirects the buyer
//   POST /stripe-webhook    -> on checkout.session.completed, places the order with Printful
//
// Requires these variables/secrets (Workers & Pages > pmensonp-site > Settings > Variables and secrets):
// STRIPE_SECRET_KEY           - your Stripe secret key (add as a Secret)
// STRIPE_PRICE_ROAD_TO_28     - Stripe Price ID for the Road to 28 tee
// STRIPE_PRICE_ETM            - Stripe Price ID for the Everything for the Moment tee
// STRIPE_WEBHOOK_SECRET       - signing secret from the Stripe webhook endpoint (whsec_..., add as a Secret)
// PRINTFUL_API_KEY            - your Printful private API token (add as a Secret)
// PRINTFUL_VARIANT_ROAD_TO_28 - Printful sync variant ID for the Road to 28 tee
// PRINTFUL_VARIANT_ETM        - Printful sync variant ID for the Everything for the Moment tee
// PRINTFUL_AUTO_CONFIRM       - "true" to send straight to production, "false" for manual draft
// SITE_URL                    - e.g. https://pmensonp.com

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/create-checkout' && request.method === 'GET') {
      return handleCreateCheckout(request, env);
    }

    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    // Everything else: serve the static site
    return env.ASSETS.fetch(request);
  },
};

async function handleCreateCheckout(request, env) {
  try {
    const url = new URL(request.url);
    const product = url.searchParams.get('product') || '';

    const priceMap = {
      'road-to-28': env.STRIPE_PRICE_ROAD_TO_28,
      'etm': env.STRIPE_PRICE_ETM,
    };
    const priceId = priceMap[product];

    if (!priceId) {
      return new Response('Unknown product. Use ?product=road-to-28 or ?product=etm', { status: 400 });
    }

    const siteUrl = env.SITE_URL || 'https://pmensonp.com';

    const body = new URLSearchParams();
    body.append('mode', 'payment');
    body.append('line_items[0][price]', priceId);
    body.append('line_items[0][quantity]', '1');
    body.append('shipping_address_collection[allowed_countries][0]', 'US');
    body.append('phone_number_collection[enabled]', 'true');
    body.append('metadata[product]', product);
    body.append('success_url', `${siteUrl}/?order=success`);
    body.append('cancel_url', `${siteUrl}/?order=cancelled`);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error(session);
      return new Response('Checkout error: ' + (session.error && session.error.message), { status: 500 });
    }

    return Response.redirect(session.url, 302);
  } catch (err) {
    return new Response('Checkout error: ' + err.message, { status: 500 });
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signedPayload = `${timestamp}.${payload}`;
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return computedSig === expectedSig;
}

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const sig = request.headers.get('stripe-signature');

  const validSignature = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!validSignature) {
    return new Response('Webhook Error: invalid signature', { status: 400 });
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(payload);
  } catch (err) {
    return new Response('Webhook Error: invalid payload', { status: 400 });
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return new Response('Ignored event type: ' + stripeEvent.type, { status: 200 });
  }

  try {
    const session = stripeEvent.data.object;

    const expandParams = new URLSearchParams();
    expandParams.append('expand[]', 'line_items');
    expandParams.append('expand[]', 'customer_details');

    const sessionRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${session.id}?${expandParams.toString()}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    const fullSession = await sessionRes.json();

    const product = (fullSession.metadata && fullSession.metadata.product) || '';

    const variantMap = {
      'road-to-28': env.PRINTFUL_VARIANT_ROAD_TO_28,
      'etm': env.PRINTFUL_VARIANT_ETM,
    };
    const variantId = variantMap[product];

    if (!variantId) {
      console.error('No Printful variant mapped for product:', product);
      return new Response('No variant mapped, skipping fulfillment for: ' + product, { status: 200 });
    }

    const shipping = fullSession.shipping_details || fullSession.customer_details;
    const address = (shipping && shipping.address) || {};
    const quantity =
      fullSession.line_items && fullSession.line_items.data[0]
        ? fullSession.line_items.data[0].quantity
        : 1;

    const autoConfirm = env.PRINTFUL_AUTO_CONFIRM !== 'false';

    const printfulOrder = {
      recipient: {
        name: (shipping && shipping.name) || fullSession.customer_details.name,
        address1: address.line1,
        address2: address.line2 || '',
        city: address.city,
        state_code: address.state,
        country_code: address.country,
        zip: address.postal_code,
        email: fullSession.customer_details.email,
        phone: fullSession.customer_details.phone || '',
      },
      items: [
        {
          variant_id: Number(variantId),
          quantity,
        },
      ],
      confirm: autoConfirm,
      external_id: session.id,
    };

    const printfulRes = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(printfulOrder),
    });

    const printfulData = await printfulRes.json();

    if (!printfulRes.ok) {
      console.error('Printful order failed:', printfulData);
      return new Response('Printful order failed: ' + JSON.stringify(printfulData), { status: 500 });
    }

    console.log('Printful order created:', printfulData.result && printfulData.result.id);
    return new Response('Order placed with Printful.', { status: 200 });
  } catch (err) {
    console.error('Fulfillment error:', err);
    return new Response('Fulfillment error: ' + err.message, { status: 500 });
  }
}
