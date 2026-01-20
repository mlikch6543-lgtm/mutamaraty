
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. App Initialization ---
const app = express();

app.use(cors({
    origin: true, 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token'],
    credentials: true
}));

app.options('*', cors());
app.use(bodyParser.json());

// --- 2. Environment Variables & Constants ---
const PORT = process.env.PORT || 3000; 

// Credentials provided
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// Paymob Configuration (Egypt)
const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY || "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJjb250ZXh0Ijp7InVzZXJfaWQiOjkwODE5MCwibFtZQSI6ImluaXRpYXRvciIsInR5cGUiOiJtZXJjaGFudCIsInByb2ZpbGVzIjpbeyIiZCI6MTExMTc0MCwibmFtZSI6ImluaXRpYXRvciIsInBlcm1pc3Npb25zIjpbInJlYWQiLCJ3cml0ZSIsImVkaXQiXX1dfSwiaWF0IjoxNzM5MDkzNTgwLCJleHAiOjE3NzA2Mjk1ODB9.e9mFpHNU8UE_iKhXw1Hu2HId0sjG0meH50CGyDl2RnydC6XeE19xGeH9tm_ZppXtDcghiLCerJlh5GDF1tJn4A";
const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID || "5419269"; 
const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID || "983782";
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || "256D3B8CC68FFB2A11BE0F247EFCDAED";

// --- 3. Firebase Initialization ---
let db = null;
let firebaseError = null;

console.log("🔄 Server Starting...");

try {
    if (!admin.apps.length) {
        // Try to use environment variable first, then fallback to provided key if needed
        let serviceAccount = null;

        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
                if (typeof rawJson === 'string') {
                    rawJson = rawJson.trim();
                    if (rawJson.startsWith("'") && rawJson.endsWith("'")) rawJson = rawJson.slice(1, -1);
                    if (rawJson.startsWith('"') && rawJson.endsWith('"') && !rawJson.includes('{')) rawJson = JSON.parse(rawJson);
                }
                serviceAccount = typeof rawJson === 'object' ? rawJson : JSON.parse(rawJson);
                if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }
            } catch (err) {
                console.error("❌ Firebase Env Parse Error:", err.message);
            }
        } 
        
        // Check if we have a valid service account object
        if (serviceAccount) {
             admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: FIREBASE_DB_URL
            });
            db = admin.database();
            console.log("✅ Firebase Connected Successfully (Service Account)!");
        } else {
            // Fallback: Initialize without credentials (works if environment has default credentials or for public DBs)
            // Note: For write access to secured DBs, a Service Account is required.
            admin.initializeApp({
                databaseURL: FIREBASE_DB_URL
            });
            db = admin.database();
            console.log("⚠️ Using Default/Guest Firebase Access (Check DB Rules if writes fail)");
        }
    } else {
        db = admin.database();
    }
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    firebaseError = `Init Error: ${error.message}`;
}

// --- 4. Bot Initialization ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on('polling_error', (err) => console.log('Telegram Polling Error (ignoring):', err.code));

// --- 5. Helpers ---
const normalizePhone = (phone) => {
    if (!phone) return '';
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('20')) p = p.substring(2);
    if (p.startsWith('0')) p = p.substring(1);
    return p;
};

const saveUserToFirebase = async (chatId, phone, firstName) => {
    if (!db) {
        bot.sendMessage(chatId, "⚠️ عذراً، السيرفر غير متصل بقاعدة البيانات حالياً.");
        return;
    }
    const cleanPhone = normalizePhone(phone);
    try {
        await db.ref(`telegram_users/${cleanPhone}`).set(chatId.toString());
        bot.sendMessage(chatId, `👋 أهلاً ${firstName}!\n✅ تم تفعيل حسابك برقم: ${cleanPhone}\nستصلك التذاكر هنا فور قبول حجزك.`);
    } catch (e) {
        console.error("Save User Error:", e);
        bot.sendMessage(chatId, "❌ حدث خطأ أثناء التسجيل.");
    }
};

bot.on('contact', async (msg) => {
    if (msg.contact && msg.contact.phone_number) {
        await saveUserToFirebase(msg.chat.id, msg.contact.phone_number, msg.chat.first_name || 'User');
    }
});

bot.onText(/\/start/, async (msg) => {
    const opts = {
        reply_markup: {
            keyboard: [[{ text: "📱 مشاركة رقمي لتفعيل التذاكر", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };
    bot.sendMessage(msg.chat.id, "أهلاً بك في بوت مؤتمرات كنيستنا! ⛪\n\nلضمان استلام التذاكر، شارك رقمك معنا:", opts);
});

// --- 6. API Routes ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: db ? 'connected' : 'disconnected', error: firebaseError });
});

/**
 * Step 1: Initiate Payment
 * Receives booking details, contacts Paymob, returns Iframe URL.
 */
app.post('/api/paymob/initiate', async (req, res) => {
    if (!PAYMOB_API_KEY) {
        console.error("Paymob Config Missing");
        return res.status(500).json({ success: false, error: 'Payment gateway configuration missing' });
    }

    try {
        const { bookingId, amount, userDetails } = req.body;
        // Paymob deals in Cents (EGP 100 = 10000 cents)
        const amountCents = Math.round(amount * 100);

        // A. Authenticate
        const authResponse = await axios.post('https://accept.paymob.com/api/auth/tokens', {
            api_key: PAYMOB_API_KEY
        });
        const token = authResponse.data.token;

        // B. Order Registration
        // merchant_order_id should be unique. We use the Booking ID.
        const orderResponse = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: token,
            delivery_needed: "false",
            amount_cents: amountCents,
            currency: "EGP",
            items: [],
            merchant_order_id: bookingId 
        });
        const orderId = orderResponse.data.id;

        // Save Paymob Order ID to Firebase immediately
        if (db) {
            await db.ref(`bookings/${bookingId}`).update({
                paymobOrderId: orderId,
                paymentStatus: 'INITIATED'
            });
        }

        // C. Payment Key Request
        const billingData = {
            apartment: "NA", 
            email: "user@church.com", 
            floor: "NA", 
            first_name: userDetails.name.split(' ')[0] || "User", 
            street: "NA", 
            building: "NA", 
            phone_number: userDetails.phone, 
            shipping_method: "NA", 
            postal_code: "NA", 
            city: "Cairo", 
            country: "EG", 
            last_name: "Member", 
            state: "NA"
        };

        const keyResponse = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
            auth_token: token,
            amount_cents: amountCents,
            expiration: 3600, // 1 hour
            order_id: orderId,
            billing_data: billingData,
            currency: "EGP",
            integration_id: PAYMOB_INTEGRATION_ID
        });

        const paymentKey = keyResponse.data.token;
        const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${paymentKey}`;

        return res.json({ success: true, url: iframeUrl });

    } catch (error) {
        console.error("Paymob Init Error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, error: "Payment initiation failed" });
    }
});

/**
 * Step 2: Webhook Handler
 * Paymob calls this when transaction status changes.
 */
app.post('/api/paymob/webhook', async (req, res) => {
    // 1. Verify HMAC
    const { obj, type, hmac } = req.body;
    
    // We only care about Transactions
    if (type !== 'TRANSACTION') return res.status(200).send();

    if (PAYMOB_HMAC_SECRET) {
        const {
            amount_cents, created_at, currency, error_occured, has_parent_transaction,
            id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
            is_standalone_payment, is_voided, order, owner, pending, source_data, success
        } = obj;

        // Paymob's strict lexical order for HMAC
        const lexicon = [
            amount_cents, created_at, currency, error_occured, has_parent_transaction,
            id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
            is_standalone_payment, is_voided, order.id, owner, pending,
            source_data.pan, source_data.sub_type, source_data.type, success
        ];

        const concatenatedString = lexicon.map(val => val.toString()).join('');
        const calculatedHmac = crypto.createHmac('sha512', PAYMOB_HMAC_SECRET)
            .update(concatenatedString)
            .digest('hex');

        if (hmac !== calculatedHmac) {
            console.error("HMAC Mismatch!");
            return res.status(403).send(); // Security check failed
        }
    }

    // 2. Process Logic
    const isSuccess = obj.success;
    const bookingId = obj.order.merchant_order_id;
    
    if (db && bookingId) {
        if (isSuccess) {
            await db.ref(`bookings/${bookingId}`).update({
                status: 'APPROVED', // Auto-approve on payment
                paymentStatus: 'PAID',
                amountPaid: obj.amount_cents / 100
            });
            console.log(`💰 Booking ${bookingId} Paid & Approved.`);
        } else {
            await db.ref(`bookings/${bookingId}`).update({
                paymentStatus: 'FAILED'
            });
            console.log(`❌ Booking ${bookingId} Payment Failed.`);
        }
    }

    res.status(200).send();
});

app.post('/api/send-approval', async (req, res) => {
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) return res.status(403).json({ error: 'Unauthorized' });
    if (!db) return res.status(503).json({ error: 'DB Disconnected' });

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        const cleanPhone = normalizePhone(phone);
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();
        
        if (!chatId) return res.json({ success: false, reason: 'user_not_found' });

        const message = `🎫 <b>تذكرة دخول</b>\n👤 ${userName}\n📅 ${conferenceTitle}\n#️⃣ ${bookingId}`;
        const qrBuffer = await QRCode.toBuffer(bookingId, { width: 400 });
        await bot.sendPhoto(chatId, qrBuffer, { caption: message, parse_mode: 'HTML' });
        return res.json({ success: true, chatId });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 7. Serve Frontend ---
const distPath = path.resolve(__dirname, '../dist');

if (fs.existsSync(distPath)) {
    console.log(`📂 Serving frontend from: ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not Found' });
        res.sendFile(path.join(distPath, 'index.html'));
    });
} else {
    console.log("⚠️ Frontend build not found. Ensure 'npm run build' runs before start.");
    app.get('/', (req, res) => res.send('Server is running, but frontend build is missing.'));
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
