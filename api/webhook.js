export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // 1. Parse Paddle Webhook Data
    const body = req.body;
    
    // Support for different Paddle payload structures (Paddle Classic or Paddle Billing)
    const customerEmail = body.p_customer_email || body.email || (body.data && body.data.customer && body.data.customer.email);
    
    if (!customerEmail) {
      return res.status(400).json({ error: 'Customer email not found in payload' });
    }

    // Load environment variables (Configured in Vercel Dashboard)
    const KEYGEN_ACCOUNT_ID = process.env.KEYGEN_ACCOUNT_ID;
    const KEYGEN_POLICY_ID = 'dc39fd8d-2d3f-4767-9182-eeee943f67e4'; // Hardcoded Policy ID
    const KEYGEN_TOKEN = process.env.KEYGEN_TOKEN;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;

    // 2. Create License in Keygen
    const keygenRes = await fetch(`https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}/licenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
        'Authorization': `Bearer ${KEYGEN_TOKEN}`
      },
      body: JSON.stringify({
        data: {
          type: 'licenses',
          attributes: {
            name: customerEmail,
            metadata: { email: customerEmail }
          },
          relationships: {
            policy: {
              data: { type: 'policies', id: KEYGEN_POLICY_ID }
            }
          }
        }
      })
    });

    if (!keygenRes.ok) {
      const errorData = await keygenRes.text();
      console.error('Keygen API Error:', errorData);
      return res.status(500).json({ error: 'Failed to create license' });
    }

    const keygenData = await keygenRes.json();
    const licenseKey = keygenData.data.attributes.key;

    // 3. Send Email via Resend API
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'FloatBoard <support@floatboard.xyz>', // Replace with your verified Resend domain
        to: customerEmail,
        subject: 'Your FloatBoard Premium License Key',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
            <h2 style="color: #0077ff;">Thank you for your purchase!</h2>
            <p>Welcome to FloatBoard Premium. Here is your License Key:</p>
            <div style="background: #f4f4f5; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 20px; text-align: center; font-weight: bold; margin: 24px 0; color: #000; border: 1px solid #ddd;">
              ${licenseKey}
            </div>
            <p>To activate your Premium features:</p>
            <ol style="line-height: 1.6;">
              <li>Open FloatBoard</li>
              <li>Click the <b>Activate Premium</b> button</li>
              <li>Enter this email exactly: <b>${customerEmail}</b></li>
              <li>Paste the License Key above</li>
              <li>Click Activate!</li>
            </ol>
            <p>If you have any questions, just reply to this email!</p>
          </div>
        `
      })
    });

    if (!resendRes.ok) {
      const resendError = await resendRes.text();
      console.error('Resend API Error:', resendError);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    // Success Response to Paddle
    return res.status(200).json({ success: true, message: 'License created and emailed' });

  } catch (error) {
    console.error('Internal Webhook Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
