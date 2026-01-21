
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

// ================= ENV & FALLBACKS =================
const DEFAULT_TELEGRAM_TOKEN = '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const DEFAULT_SECRET_KEY = "CHURCH_CONF_SECURE_2025";
// الرابط الصحيح لقاعدة البيانات
const CORRECT_DB_URL = 'https://mutamaraty-default-rtdb.firebaseio.com';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || DEFAULT_TELEGRAM_TOKEN;
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || DEFAULT_SECRET_KEY;

// تصحيح ذكي لرابط قاعدة البيانات
let targetDbUrl = process.env.FIREBASE_DB_URL || CORRECT_DB_URL;
if (targetDbUrl.includes('console.firebase.google.com')) {
    console.warn("⚠️ Detected Console URL in FIREBASE_DB_URL. Auto-switching to correct API URL.");
    targetDbUrl = CORRECT_DB_URL;
}
const FIREBASE_DB_URL = targetDbUrl;

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY;
// معرفات الدمج الجديدة (تستخدم القيم الافتراضية إذا لم توجد في ENV)
const PAYMOB_INTEGRATION_ID_CARD = process.env.PAYMOB_INTEGRATION_ID_CARD || '5419269';
const PAYMOB_INTEGRATION_ID_WALLET = process.env.PAYMOB_INTEGRATION_ID_WALLET || '5474950';

const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID;
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;

// ================= FIREBASE =================
let db = null;

try {
  if (FIREBASE_SERVICE_ACCOUNT) {
    let serviceAccount;
    try {
        // محاولة تنظيف النص من أي أحرف غريبة ناتجة عن النسخ واللصق
        const cleanJson = FIREBASE_SERVICE_ACCOUNT.trim();
        // معالجة Newlines إذا كانت escaped
        serviceAccount = JSON.parse(cleanJson.replace(/\\n/g, '\n'));
    } catch (e) {
        console.error("JSON Parse Error (First Attempt):", e.message);
        try {
            // محاولة أخيرة للقراءة المباشرة
            serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
        } catch (e2) {
             console.error("JSON Parse Error (Final):", e2.message);
        }
    }

    if (serviceAccount && !admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_DB_URL
        });
        db = admin.database();
        console.log(`✅ Firebase Connected via Service Account to: ${FIREBASE_DB_URL}`);
    } else if (admin.apps.length) {
        db = admin.database();
    }
  } 
  else if (!admin.apps.length) {
      admin.initializeApp({
          databaseURL: FIREBASE_DB_URL
      });
      db = admin.database();
      console.log(`⚠️ Firebase Connected (No Auth) to: ${FIREBASE_DB_URL}`);
  } else {
      db = admin.database();
  }
} catch (e) {
  console.error('❌ Firebase Init Error:', e.message);
}

// ================= TELEGRAM =================
let bot = null;
if (TELEGRAM_TOKEN) {
    try {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
        console.log('✅ Telegram Bot Started');

        const normalizePhone = (p = '') =>
          p.replace(/\D/g, '').replace(/^20|^0/, '');

        bot.on('contact', async msg => {
          if(db) {
              const phone = normalizePhone(msg.contact.phone_number);
              try {
                await db.ref(`telegram_users/${phone}`).set(msg.chat.id);
                bot.sendMessage(msg.chat.id, '✅ تم التفعيل بنجاح. ستصلك تذاكرك هنا.');
              } catch (dbErr) {
                console.error("DB Write Error:", dbErr.message);
                bot.sendMessage(msg.chat.id, '⚠️ حدث خطأ أثناء حفظ بياناتك، حاول مرة أخرى.');
              }
          } else {
              bot.sendMessage(msg.chat.id, '⚠️ الخادم غير متصل بقاعدة البيانات حالياً.');
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
        
        bot.on('polling_error', (error) => {
            if (error.code !== 'ETELEGRAM') console.log("Polling Error:", error.message);
        });
    } catch (err) {
        console.error("❌ Telegram Init Error:", err.message);
    }
}

// ================= HEALTH =================
app.get('/api/health', (req, res) => {
  res.json({ 
      ok: true, 
      paymob: !!PAYMOB_API_KEY,
      firebase: !!db,
      dbUrl: FIREBASE_DB_URL, // لإظهار الرابط المستخدم فعلياً للتأكد
      bot: !!bot,
      secretCheck: SERVER_SECRET_KEY === DEFAULT_SECRET_KEY ? "Default" : "Custom"
  });
});

// ================= PAYMOB INIT =================
app.post('/api/paymob/initiate', async (req, res) => {
  try {
    if (!PAYMOB_API_KEY) {
        throw new Error("Paymob API Key is missing on server");
    }

    const { bookingId, amount, userDetails, paymentMethod } = req.body;
    const amountCents = Math.round(amount * 100);

    // تحديد نوع الدمج (كارت أو محفظة)
    // الافتراضي هو الكارت (Card)
    const integrationId = paymentMethod === 'WALLET' ? PAYMOB_INTEGRATION_ID_WALLET : PAYMOB_INTEGRATION_ID_CARD;

    const auth = await axios.post(
      'https://accept.paymob.com/api/auth/tokens',
      { api_key: PAYMOB_API_KEY }
    );
    const token = auth.data.token;

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

    const billingData = {
        "apartment": "NA",
        "email": "user@church.app",
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
        integration_id: integrationId
      }
    );

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
      url: `https://accept.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${key.data.token}`,
      token: key.data.token // Useful for mobile SDKs or custom flows
    });

  } catch (e) {
    console.error('❌ Paymob Error:', e.response?.data || e.message);
    res.status(500).json({ 
        error: "Payment initiation failed", 
        details: e.response?.data || e.message 
    });
  }
});

// ================= SEND APPROVAL =================
app.post('/api/send-approval', async (req, res) => {
    const receivedToken = req.headers['x-admin-token'];
    
    const isValid = (receivedToken === SERVER_SECRET_KEY) || (receivedToken === DEFAULT_SECRET_KEY);

    if (!isValid) {
        console.error(`⛔ Auth Failed. Received: '${receivedToken}'`);
        return res.status(403).json({ success: false, error: 'Unauthorized: Invalid Secret Key' });
    }
    
    if (!db) return res.status(503).json({ success: false, reason: 'db_error', error: 'Database not connected' });
    if (!bot) return res.status(503).json({ success: false, reason: 'bot_error', error: 'Bot not initialized' });

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        
        const cleanPhone = phone.replace(/\D/g, '').replace(/^20|^0/, '');
        
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) {
            console.log(`⚠️ User not found in telegram_users for phone: ${cleanPhone}`);
            return res.json({ success: false, reason: 'user_not_found' });
        }

        const message = `🎫 <b>تم قبول حجزك!</b>\n\n👤 <b>${userName}</b>\n📅 ${conferenceTitle}\n📍 ${date}\n#️⃣ رقم الحجز: <code>${bookingId}</code>\n\nيرجى الاحتفاظ بهذا الباركود للدخول.`;
        const qrBuffer = await QRCode.toBuffer(bookingId.toString(), { width: 400 });
        
        await bot.sendPhoto(chatId, qrBuffer, { caption: message, parse_mode: 'HTML' });
        console.log(`✅ Ticket sent to ${userName} (${chatId})`);
        
        return res.json({ success: true, chatId });
    } catch (error) {
        console.error("❌ Send Error:", error.message);
        if (error.response && error.response.statusCode === 403) {
            return res.json({ success: false, reason: 'bot_blocked' });
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});


// ================= START =================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Database URL: ${FIREBASE_DB_URL}`);
  console.log(`💳 Paymob IDs Loaded: Card(${PAYMOB_INTEGRATION_ID_CARD}) | Wallet(${PAYMOB_INTEGRATION_ID_WALLET})`);
});
