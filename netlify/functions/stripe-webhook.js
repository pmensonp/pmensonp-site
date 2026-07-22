// Stripe webhook: on a completed checkout, place a matching order with Printful
// so fulfillment happens automatically with no manual steps.
//
// In Stripe Dashboard, add an endpoint pointing at:
//   https://pmensonp.com/.netlify/functions/stripe-webhook
// listening for: checkout.session.completed
//
// Requires these Netlify environment variables:
// STRIPE_SECRET_KEY        - your Stripe secret key
// STRIPE_WEBHOOK_SECRET    - signing secret from the Stripe webhook endpoint (whsec_...)
// PRINTFUL_API_KEY         - your Printful private API token
// PRINTFUL_VARIANT_ROAD_TO_28 - Printful sync variant ID for the Road to 28 tee
// PRINTFUL_VARIANT_ETM         - Printful sync variant ID for the Everything for the Moment tee
// PRINTFUL_AUTO_CONFIRM    - "true" to send straight to production, "false" to leave
//                            as a draft you approve manually in Printful (default: true)

const Stripe = require('stripe');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored event type: ' + stripeEvent.type };
  }

  try {
    const session = stripeEvent.data.object;

    // Pull full shipping + line item detail from Stripe.
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items', 'customer_details'],
    });

    const product = (fullSession.metadata && fullSession.metadata.product) || '';

    const variantMap = {
      'road-to-28': process.env.PRINTFUL_VARIANT_ROAD_TO_28,
      'etm': process.env.PRINTFUL_VARIANT_ETM,
    };
    const variantId = variantMap[product];

    if (!variantId) {
      console.error('No Printful variant mapped for product:', product);
      return { statusCode: 200, body: 'No variant mapped, skipping fulfillment for: ' + product };
    }

    const shipping = fullSession.shipping_details || fullSession.customer_details;
    const address = (shipping && shipping.address) || {};
    const quantity = (fullSession.line_items && fullSession.line_items.data[0]
      ? fullSession.line_items.data[0].quantity
      : 1);

    const autoConfirm = process.env.PRINTFUL_AUTO_CONFIRM !== 'false';

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
          variant_id: variantId,
          quantity: quantity,
        },
      ],
      confirm: autoConfirm,
      external_id: session.id,
    };

    const printfulRes = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(printfulOrder),
    });

    const printfulData = await printfulRes.json();

    if (!printfulRes.ok) {
      console.error('Printful order failed:', printfulData);
      return { statusCode: 500, body: 'Printful order failed: ' + JSON.stringify(printfulData) };
    }

    console.log('Printful order created:', printfulData.result && printfulData.result.id);
    return { statusCode: 200, body: 'Order placed with Printful.' };
  } catch (err) {
    console.error('Fulfillment error:', err);
    return { statusCode: 500, body: 'Fulfillment error: ' + err.message };
  }
};
