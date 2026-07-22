// Creates a Stripe Checkout session for a product and redirects the buyer there.
// Call as: /.netlify/functions/create-checkout?product=road-to-28
// or:      /.netlify/functions/create-checkout?product=etm
//
// Requires these Netlify environment variables:
//   STRIPE_SECRET_KEY            - your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_PRICE_ROAD_TO_28       - Stripe Price ID for the Road to 28 tee
//   STRIPE_PRICE_ETM              - Stripe Price ID for the Everything for the Moment tee
//   SITE_URL                      - e.g. https://pmensonp.com

const Stripe = require('stripe');

exports.handler = async (event) => {
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const siteUrl = process.env.SITE_URL || 'https://pmensonp.com';

    const product = (event.queryStringParameters && event.queryStringParameters.product) || '';

    const priceMap = {
      'road-to-28': process.env.STRIPE_PRICE_ROAD_TO_28,
      'etm': process.env.STRIPE_PRICE_ETM,
    };

    const priceId = priceMap[product];

    if (!priceId) {
      return {
        statusCode: 400,
        body: 'Unknown product. Use ?product=road-to-28 or ?product=etm',
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      metadata: { product },
      success_url: `${siteUrl}/?order=success`,
      cancel_url: `${siteUrl}/?order=cancelled`,
    });

    return {
      statusCode: 302,
      headers: { Location: session.url },
      body: '',
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Checkout error: ' + err.message };
  }
};
