
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import QRCode from 'qrcode';
import axios from 'axios';
import crypto from 'crypto';

const app = express();
// Enable CORS for all origins and specific headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token']
}));
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
  if (FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    // Handle both stringified JSON and raw object
    try {
        serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
        // Maybe it's already an object or has issue, try cleaning newlines
        serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT.replace(/\\n/g, '\n'));
    }

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_DB_URL
        });
    }
    db = admin.database();
    console.log('✅ Firebase Connected');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT is missing');
  }
} catch (e) {
  console.error('❌ Firebase Error:', e.message);
}

// ================= TELEGRAM =================
let bot = null;
if (TELEGRAM_TOKEN) {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    
    const normalizePhone = (p = '') =>
      p.replace(/\D/g, '').replace(/^20|^0/, '');

    bot.on('contact', async msg => {
      if(db) {
          const phone = normalizePhone(msg.contact.phone_number);
          await db.ref(`telegram_users/${phone}`).set(msg.chat.id);
          bot.sendMessage(msg.chat.id, '✅ تم التفعيل بنجاح. ستصلك تذاكرك هنا.');
      }
    });

    bot.onText(/\/start/, msg => {
      bot.sendMessage(msg.chat.id, 'أهلاً بك في بوت المؤتمرات ⛪\nلربط حسابك، يرجى مشاركة رقم هاتفك.', {
        reply_markup: {
          keyboard: [[{ text: '📱 مشاركة رقمي', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      });
    });
    
    // Global Error Handler for Bot to prevent crashing
    bot.on('polling_error', (error) => {
        // Suppress polling errors
    });
}

// ================= HEALTH =================
app.get('/api/health', (req, res) => {
  res.json({ 
      ok: true, 
      paymob: !!PAYMOB_API_KEY,
      firebase: !!db
  });
});

// ================= PAYMOB INIT =================
app.post('/api/paymob/initiate', async (req, res) => {
  try {
    if (!PAYMOB_API_KEY) {
        throw new Error("Paymob API Key is missing on server");
    }

    const { bookingId, amount, userDetails } = req.body;
    const amountCents = Math.round(amount * 100);

    // 1. Authentication
    const auth = await axios.post(
      'https://accept.paymob.com/api/auth/tokens',
      { api_key: PAYMOB_API_KEY }
    );
    const token = auth.data.token;

    // 2. Order Registration
    const order = await axios.post(
      'https://accept.paymob.com/api/ecommerce/orders',
      {
        auth_token: token,
        delivery_needed: "false",
        amount_cents: amountCents,
        currency: 'EGP',
        items: [],
        merchant_order_id: bookingId.toString()
      }
    );

    // 3. Payment Key Generation
    // CRITICAL: Paymob requires full billing data even for digital goods
    const billingData = {
        "apartment": "NA",
        "email": "user@church.app", // Mandatory field
        "floor": "NA",
        "first_name": userDetails?.name ? userDetails.name.split(' ')[0] : "User",
        "street": "NA",
        "building": "NA",
        "phone_number": userDetails?.phone || "01000000000",
        "shipping_method": "NA",
        "postal_code": "NA",
        "city": "Cairo",
        "country": "EG",
        "last_name": userDetails?.name ? (userDetails.name.split(' ').slice(1).join(' ') || "Member") : "Member",
        "state": "NA"
    };

    const key = await axios.post(
      'https://accept.paymob.com/api/acceptance/payment_keys',
      {
        auth_token: token,
        amount_cents: amountCents,
        expiration: 3600,
        order_id: order.data.id,
        billing_data: billingData,
        currency: 'EGP',
        integration_id: PAYMOB_INTEGRATION_ID
      }
    );

    // Update DB with Order ID if available
    if (db) {
        try {
            await db.ref(`bookings/${bookingId}`).update({
                paymobOrderId: order.data.id,
                paymentStatus: 'INITIATED'
            });
        } catch(err) {
            console.error("DB Update Error", err);
        }
    }

    res.json({
      success: true,
      url: `https://accept.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${key.data.token}`
    });

  } catch (e) {
    console.error('❌ Paymob Error:', e.response?.data || e.message);
    // Send detailed error to client for debugging
    res.status(500).json({ 
        error: "Payment initiation failed", 
        details: e.response?.data || e.message 
    });
  }
});

// ================= SEND APPROVAL =================
app.post('/api/send-approval', async (req, res) => {
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    if (!db || !bot) return res.status(503).json({ success: false, reason: 'service_unavailable' });

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        
        // Normalize phone to match keys in DB
        const cleanPhone = phone.replace(/\D/g, '').replace(/^20|^0/, '');
        
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) return res.json({ success: false, reason: 'user_not_found' });

        const message = `🎫 <b>تم قبول حجزك!</b>\n\n👤 <b>${userName}</b>\n📅 ${conferenceTitle}\n📍 ${date}\n#️⃣ رقم الحجز: <code>${bookingId}</code>\n\nيرجى الاحتفاظ بهذا الباركود للدخول.`;
        const qrBuffer = await QRCode.toBuffer(bookingId.toString(), { width: 400 });
        
        await bot.sendPhoto(chatId, qrBuffer, { caption: message, parse_mode: 'HTML' });
        
        return res.json({ success: true, chatId });
    } catch (error) {
        console.error("Send Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ================= START =================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
