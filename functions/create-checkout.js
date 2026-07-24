// Creates a Stripe Checkout session for a product and redirects the buyer there.
// Cloudflare Pages Function — file path maps directly to the route:
//   functions/create-checkout.js  ->  /create-checkout
// Call as: /create-checkout?product=road-to-28
// or:      /create-checkout?product=etm
//
// Requires these Cloudflare Pages environment variables
// (Project > Settings > Environment variables):
// STRIPE_SECRET_KEY       - your Stripe secret key (sk_live_... or sk_test_...)
// STRIPE_PRICE_ROAD_TO_28 - Stripe Price ID for the Road to 28 tee
// STRIPE_PRICE_ETM        - Stripe Price ID for the Everything for the Moment tee
// SITE_URL                - e.g. https://pmensonp.com
//
// Uses the plain Stripe REST API via fetch (no npm dependency needed —
// Cloudflare Pages Functions run on the Workers runtime, not Node.js).

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const product = url.searchParams.get('product') || '';

    const priceMap = {
      'road-to-28': env.STRIPE_PRICE_ROAD_TO_28,
      'etm': env.STRIPE_PRICE_ETM,
    };

    const priceId = priceMap[product];

    if (!priceId) {
      return new Response('Unknown product. Use ?product=road-to-28 or ?product=etm', {
        status: 400,
      });
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
      return new Response('Checkout error: ' + (session.error && session.error.message), {
        status: 500,
      });
    }

    return Response.redirect(session.url, 302);
  } catch (err) {
    return new Response('Checkout error: ' + err.message, { status: 500 });
  }
}
