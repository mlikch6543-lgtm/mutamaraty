import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import QRCode from 'qrcode';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// ================= ENV =================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY;

const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY;
const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID;
const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID;
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;

// ================= FIREBASE =================
let db = null;

try {
  const serviceAccount = JSON.parse(
    FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n')
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DB_URL
  });

  db = admin.database();
  console.log('✅ Firebase Connected');
} catch (e) {
  console.error('❌ Firebase Error:', e.message);
}

// ================= TELEGRAM =================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const normalizePhone = (p = '') =>
  p.replace(/\D/g, '').replace(/^20|^0/, '');

bot.on('contact', async msg => {
  const phone = normalizePhone(msg.contact.phone_number);
  await db.ref(`telegram_users/${phone}`).set(msg.chat.id);
  bot.sendMessage(msg.chat.id, '✅ تم التفعيل بنجاح');
});

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, '📱 ابعت رقمك', {
    reply_markup: {
      keyboard: [[{ text: 'مشاركة رقمي', request_contact: true }]],
      resize_keyboard: true
    }
  });
});

// ================= HEALTH =================
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// ================= PAYMOB INIT =================
app.post('/api/paymob/initiate', async (req, res) => {
  try {
    const { bookingId, amount } = req.body;

    const auth = await axios.post(
      'https://accept.paymob.com/api/auth/tokens',
      { api_key: PAYMOB_API_KEY }
    );

    const order = await axios.post(
      'https://accept.paymob.com/api/ecommerce/orders',
      {
        auth_token: auth.data.token,
        amount_cents: amount * 100,
        currency: 'EGP',
        items: [],
        merchant_order_id: bookingId
      }
    );

    const key = await axios.post(
      'https://accept.paymob.com/api/acceptance/payment_keys',
      {
        auth_token: auth.data.token,
        amount_cents: amount * 100,
        expiration: 3600,
        order_id: order.data.id,
        billing_data: {
          first_name: 'User',
          last_name: 'Church',
          phone_number: '01000000000',
          city: 'Cairo',
          country: 'EG'
        },
        currency: 'EGP',
        integration_id: PAYMOB_INTEGRATION_ID
      }
    );

    res.json({
      url: `https://accept.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${key.data.token}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= START =================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Running on ${PORT}`);
});
