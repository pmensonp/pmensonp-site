// Stripe webhook: on a completed checkout, place a matching order with Printful
// so fulfillment happens automatically with no manual steps.
//
// Cloudflare Pages Function — file path maps directly to the route:
//   functions/stripe-webhook.js  ->  /stripe-webhook
//
// In Stripe Dashboard, add an endpoint pointing at:
//   https://pmensonp.com/stripe-webhook
// listening for: checkout.session.completed
//
// Requires these Cloudflare Pages environment variables
// (Project > Settings > Environment variables):
// STRIPE_SECRET_KEY           - your Stripe secret key
// STRIPE_WEBHOOK_SECRET       - signing secret from the Stripe webhook endpoint (whsec_...)
// PRINTFUL_API_KEY            - your Printful private API token
// PRINTFUL_VARIANT_ROAD_TO_28 - Printful sync variant ID for the Road to 28 tee
// PRINTFUL_VARIANT_ETM        - Printful sync variant ID for the Everything for the Moment tee
// PRINTFUL_AUTO_CONFIRM       - "true" to send straight to production, "false" to leave
//                               as a draft you approve manually in Printful (default: true)
//
// Uses fetch + the Web Crypto API for signature verification (no npm dependency
// needed — Cloudflare Pages Functions run on the Workers runtime, not Node.js).

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

export async function onRequestPost(context) {
  const { request, env } = context;

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
      return new Response('No variant mapped, skipping fulfillment for: ' + product, {
        status: 200,
      });
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
      return new Response('Printful order failed: ' + JSON.stringify(printfulData), {
        status: 500,
      });
    }

    console.log('Printful order created:', printfulData.result && printfulData.result.id);
    return new Response('Order placed with Printful.', { status: 200 });
  } catch (err) {
    console.error('Fulfillment error:', err);
    return new Response('Fulfillment error: ' + err.message, { status: 500 });
  }
}
