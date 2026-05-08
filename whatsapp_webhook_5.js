/**
 * ════════════════════════════════════════════════════════════════════════════
 * ASSIGNIQUE — WhatsApp Business API Auto-Reply Webhook (Node.js)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This is a SEPARATE Node.js server you deploy to receive WhatsApp messages
 * and auto-reply. The dashboard reads chats from this server via JSON.
 *
 * WHAT THIS DOES:
 * • Receives every WhatsApp message sent to your business number
 * • Pattern-matches the message against your auto-reply templates
 * • Sends instant reply via WhatsApp Cloud API (free for first 1,000 chats/mo)
 * • Logs every conversation so your dashboard can show unanswered chats
 * • Forwards complex queries to a "needs human" queue
 *
 * SETUP (one-time, ~30 minutes):
 *
 * 1. Apply for WhatsApp Business Cloud API (FREE tier):
 *    https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
 *    → Create Meta app → add WhatsApp product → get test number first
 *
 * 2. Get these 3 values from Meta:
 *    - PHONE_NUMBER_ID  (your WA phone ID)
 *    - ACCESS_TOKEN     (permanent token, not the temporary one)
 *    - VERIFY_TOKEN     (any random string YOU choose, e.g. "assignique_2026")
 *
 * 3. Deploy this code to Render.com or Vercel (both free tier):
 *    a. Create new project → import from GitHub
 *    b. Set environment variables (PHONE_NUMBER_ID, ACCESS_TOKEN, VERIFY_TOKEN)
 *    c. Deploy → copy the public URL (e.g. https://assignique.onrender.com)
 *
 * 4. In Meta dashboard → WhatsApp → Configuration → Webhook:
 *    Callback URL: https://YOUR-DEPLOYMENT.com/webhook
 *    Verify token: your VERIFY_TOKEN
 *    Subscribe to: messages
 *
 * 5. In your Assignique dashboard Settings page, paste the URL.
 *    Dashboard will fetch /api/conversations every 30 seconds.
 *
 * Done — every WhatsApp message now auto-replies based on your templates.
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── ENV — set in Render/Vercel dashboard ───────────────────────────────────
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'YOUR_PHONE_ID';
const ACCESS_TOKEN    = process.env.ACCESS_TOKEN    || 'YOUR_TOKEN';
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'assignique_2026';
const PORT            = process.env.PORT || 3000;

const STORAGE_FILE    = '/tmp/conversations.json';

// ─── AUTO-REPLY TEMPLATES — edit these freely ───────────────────────────────
const TEMPLATES = [
  {
    name: 'catalog',
    triggers: /\b(catalog|catalogue|services|menu|price list|rates|pricing)\b/i,
    reply: `Hi! 👋 Thanks for reaching out to Assignique!

Here's what we do:
📝 Decorative Assignments — from ₹800
📊 Normal Assignments — from ₹500
📚 Research Papers — from ₹2,000
🎨 Handwritten Notes — from ₹600
📋 Case Studies — from ₹1,800

✅ 100% original  ✅ On-time delivery  ✅ Free revision

Send us your topic, pages, and deadline — we'll give you an exact quote in minutes! 🚀`
  },
  {
    name: 'price',
    triggers: /\b(price|cost|how much|charges|fee|fees|kitne)\b/i,
    reply: `Hi! Our pricing depends on:
• Number of pages
• Type (decorative / normal)
• Deadline (urgent = +20%)

Quick estimates:
📝 10-page assignment: ₹500–800
📚 20-page decorative: ₹1,500–2,500
🎓 Research paper: ₹2,000+

Send your details and I'll give you an exact quote! 🎯`
  },
  {
    name: 'urgent',
    triggers: /\b(urgent|asap|today|tonight|tomorrow|jaldi|fast)\b/i,
    reply: `⚡ Yes, we do URGENT deliveries!

✅ 24-hour delivery available
✅ Same-day for shorter assignments
✅ Quality never compromised
✅ Expert writers standing by

Share your topic, pages, and exact deadline RIGHT NOW — we'll start immediately! 🔥`
  },
  {
    name: 'sample',
    triggers: /\b(sample|example|portfolio|previous work|kaisi hai)\b/i,
    reply: `Hi! 📂 We'd love to share samples!

We work on:
🎨 Decorative project files
📝 Handwritten assignments
📚 Research papers
📋 Case studies

What subject do you need help with? I'll send you 2-3 samples in that exact area within minutes! 💪`
  },
  {
    name: 'greeting',
    triggers: /^(hi|hello|hey|hii|namaste|hola|good morning|good evening)\b/i,
    reply: `Hi there! 👋 Welcome to Assignique!

We help students with:
📝 Decorative & Normal assignments
📚 Research papers, case studies, thesis
🎨 Handwritten notes & projects

What can we help you with today? Share:
1. Type of work
2. Number of pages
3. Deadline

I'll get you an exact quote in 2 minutes! 🎯`
  },
  {
    name: 'payment_query',
    triggers: /\b(payment|paid|paise|pay|upi|gpay|phonepe)\b/i,
    reply: `Hi! Our payment is simple:

💳 50% advance to start
💳 50% before delivery

UPI: 7678327082@paytm
Or share your name and order ID — I'll send you the payment link!

Once paid, please share screenshot here for confirmation. 🙏`
  },
  {
    name: 'delivery_query',
    triggers: /\b(when|deliver|delivery|kab|status|update|progress)\b/i,
    reply: `Hi! For order updates, please share:
1. Your name (as on order form)
2. Order topic / type

I'll check the progress and update you within 5 minutes! 📊

Or fill the form again here:
https://docs.google.com/forms/d/e/1FAIpQLScU7ErUnb6VZtYT8g_jVQljf7rEj92nUuAND2tlCCTk4Ek8_Q/viewform`
  },
];

// ─── STORAGE — simple JSON file (use a real DB in production) ───────────────
function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConversations(data) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Save failed:', e);
  }
}

// ─── CORE: SEND A WHATSAPP MESSAGE ──────────────────────────────────────────
async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    }, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    return { ok: true, id: res.data.messages[0].id };
  } catch (err) {
    console.error('WA send failed:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

// ─── PATTERN-MATCH AND PICK A REPLY ─────────────────────────────────────────
function findReply(message) {
  const text = (message || '').toLowerCase();
  for (const t of TEMPLATES) {
    if (t.triggers.test(text)) {
      return { template: t.name, reply: t.reply };
    }
  }
  return null;
}

// ─── WEBHOOK VERIFICATION (Meta calls this once at setup) ───────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── WEBHOOK RECEIVER (every WA message hits this) ──────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);  // ACK immediately

  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];

    if (!msg || msg.type !== 'text') return;

    const from = msg.from;             // customer's phone
    const text = msg.text.body;        // their message
    const name = value.contacts?.[0]?.profile?.name || 'Unknown';

    console.log(`📥 ${name} (${from}): ${text}`);

    // Save incoming message
    const convos = loadConversations();
    if (!convos[from]) convos[from] = { name, messages: [], answered: false };
    convos[from].messages.push({
      from: 'customer', text, timestamp: new Date().toISOString()
    });
    convos[from].name = name;

    // Try auto-reply
    const match = findReply(text);
    if (match) {
      const result = await sendWhatsApp(from, match.reply);
      if (result.ok) {
        convos[from].messages.push({
          from: 'bot', text: match.reply, template: match.template,
          timestamp: new Date().toISOString()
        });
        convos[from].answered = true;
        console.log(`🤖 Auto-replied with template: ${match.template}`);
      }
    } else {
      // No match — flag for human follow-up
      convos[from].answered = false;
      convos[from].needs_human = true;
      console.log(`⚠ No template match — flagged for human reply`);
    }

    saveConversations(convos);

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ─── DASHBOARD API: list conversations ──────────────────────────────────────
app.get('/api/conversations', (req, res) => {
  const convos = loadConversations();
  const list = Object.entries(convos).map(([phone, data]) => ({
    phone,
    name: data.name,
    answered: data.answered,
    needs_human: data.needs_human || false,
    last_message: data.messages[data.messages.length - 1]?.text || '',
    last_at: data.messages[data.messages.length - 1]?.timestamp || '',
    message_count: data.messages.length,
  }));
  res.json({
    ok: true,
    total: list.length,
    needs_human: list.filter(c => c.needs_human).length,
    conversations: list.sort((a, b) => b.last_at.localeCompare(a.last_at))
  });
});

// ─── DASHBOARD API: full chat for one customer ──────────────────────────────
app.get('/api/conversations/:phone', (req, res) => {
  const convos = loadConversations();
  const c = convos[req.params.phone];
  if (!c) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, conversation: c });
});

// ─── DASHBOARD API: send manual reply ───────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'phone and message required' });
  }
  const result = await sendWhatsApp(phone, message);
  if (result.ok) {
    const convos = loadConversations();
    if (!convos[phone]) convos[phone] = { name: 'Unknown', messages: [], answered: true };
    convos[phone].messages.push({
      from: 'owner', text: message, timestamp: new Date().toISOString()
    });
    convos[phone].answered = true;
    convos[phone].needs_human = false;
    saveConversations(convos);
  }
  res.json(result);
});

// ─── DASHBOARD API: bulk send (for marketing campaigns) ─────────────────────
app.post('/api/broadcast', async (req, res) => {
  const { phones, message } = req.body;
  if (!Array.isArray(phones) || !message) {
    return res.status(400).json({ ok: false, error: 'phones[] and message required' });
  }
  const results = [];
  for (const phone of phones) {
    const r = await sendWhatsApp(phone, message);
    results.push({ phone, ...r });
    await new Promise(r => setTimeout(r, 1000));  // 1 msg/sec to avoid throttling
  }
  res.json({ ok: true, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});

// ─── HEALTH CHECK ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <h1>Assignique WhatsApp Webhook</h1>
    <p>Status: Running ✅</p>
    <p>Endpoints:</p>
    <ul>
      <li>GET /webhook — Meta verification</li>
      <li>POST /webhook — Receive messages</li>
      <li>GET /api/conversations — List all chats</li>
      <li>GET /api/conversations/:phone — One chat</li>
      <li>POST /api/send — Send a manual reply</li>
      <li>POST /api/broadcast — Bulk send</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Assignique webhook running on port ${PORT}`);
  console.log(`Templates loaded: ${TEMPLATES.length}`);
});
