// Rewrites the tracking URL on every fulfillment to point at your own
// tracking page instead of Shopify's auto-generated 17track link.
//
// Env vars needed:
//   SHOPIFY_STORE_DOMAIN   e.g. "bwoost-store.myshopify.com"
//   SHOPIFY_ACCESS_TOKEN   Admin API access token (starts with shpat_)
//   SHOPIFY_WEBHOOK_SECRET API secret key / client secret from the custom
//                          app's "API credentials" page in Shopify admin

const express = require('express');
const crypto = require('crypto');

const app = express();

// Capture the raw body BEFORE JSON parsing — HMAC must be computed on the
// exact bytes Shopify sent, not on a re-serialized object.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const API_VERSION = '2026-07';
const TRACKING_BASE_URL = 'https://bwoost.co/pages/tracking';

function isValidShopifyWebhook(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader || !req.rawBody || !SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/webhooks/fulfillment-created', async (req, res) => {
  if (!isValidShopifyWebhook(req)) {
    return res.status(401).send('Invalid signature');
  }

  // Ack immediately — Shopify retries (and can eventually drop the
  // subscription) if it doesn't get a fast 200.
  res.status(200).send('OK');

  try {
    const fulfillment = req.body;
    const trackingNumber = fulfillment.tracking_number;
    if (!trackingNumber) return;

    const fulfillmentGid = `gid://shopify/Fulfillment/${fulfillment.id}`;
    const newTrackingUrl = `${TRACKING_BASE_URL}?number=${encodeURIComponent(trackingNumber)}`;

    const query = `
      mutation FulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!) {
        fulfillmentTrackingInfoUpdate(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: false) {
          fulfillment { id trackingInfo { company number url } }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      fulfillmentId: fulfillmentGid,
      trackingInfoInput: {
        company: fulfillment.tracking_company || 'YunExpress',
        number: trackingNumber,
        url: newTrackingUrl
      }
    };

    const response = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query, variables })
      }
    );

    const result = await response.json();
    const errors = result?.data?.fulfillmentTrackingInfoUpdate?.userErrors;

    if (errors?.length) {
      console.error('Shopify rejected the update:', errors);
    } else {
      console.log('Tracking URL updated:', result?.data?.fulfillmentTrackingInfoUpdate?.fulfillment?.trackingInfo);
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
