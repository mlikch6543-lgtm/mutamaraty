
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
 * Final Version - Robust Connection, Diagnostics & Bot Logic & Paymob Integration
 */

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. تهيئة التطبيق ---
const app = express();

app.use(cors({
    origin: true, 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token'],
    credentials: true
}));

app.options('*', cors());
app.use(bodyParser.json());

// --- 2. إعدادات البيئة ---
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// Paymob Config (From Environment Variables)
// تأكد من إضافة هذه المتغيرات في Railway
const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY; 
const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID; 
const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID;
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET;

// --- 3. تهيئة Firebase ---
let db = null;
let firebaseError = null;

console.log("🔄 Server Starting...");

try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
                if (typeof rawJson === 'string') {
                    rawJson = rawJson.trim();
                    if (rawJson.startsWith("'") && rawJson.endsWith("'")) rawJson = rawJson.slice(1, -1);
                    if (rawJson.startsWith('"') && rawJson.endsWith('"') && !rawJson.includes('{')) rawJson = JSON.parse(rawJson);
                }
                let serviceAccount = typeof rawJson === 'object' ? rawJson : JSON.parse(rawJson);
                if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    databaseURL: FIREBASE_DB_URL
                });
                db = admin.database();
                console.log("✅ Firebase Connected Successfully!");
            } catch (err) {
                console.error("❌ Firebase JSON Parse Error:", err.message);
                firebaseError = `JSON Error: ${err.message}`;
            }
        } else {
            console.warn("⚠️ Warning: FIREBASE_SERVICE_ACCOUNT is missing.");
            firebaseError = "Missing Env Var";
        }
    } else {
        db = admin.database();
    }
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
    firebaseError = `Init Error: ${error.message}`;
}

// --- 4. Telegram Bot ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on('polling_error', (error) => {
    if (error.code !== 'ETELEGRAM') console.log("Telegram Polling Error:", error.code);
}); 

// Helper Functions
const normalizePhone = (phone) => {
    if (!phone) return '';
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('20')) p = p.substring(2);
    if (p.startsWith('0')) p = p.substring(1);
    return p;
};

const saveUserToFirebase = async (chatId, phone, firstName) => {
    if (!db) {
        bot.sendMessage(chatId, "⚠️ السيرفر غير متصل بقاعدة البيانات.");
        return;
    }
    const cleanPhone = normalizePhone(phone);
    try {
        await db.ref(`telegram_users/${cleanPhone}`).set(chatId.toString());
        bot.sendMessage(chatId, `👋 أهلاً ${firstName}!\n✅ تم تفعيل حسابك برقم: ${cleanPhone}`);
    } catch (e) {
        console.error("Save User Error:", e);
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
    bot.sendMessage(msg.chat.id, "أهلاً بك في بوت مؤتمرات كنيستنا! ⛪\n\nاضغط على الزر بالأسفل لمشاركة رقمك وربط حسابك.", opts);
});

// --- 5. API Routes ---

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        db: db ? 'connected' : 'disconnected',
        error: firebaseError,
        bot: 'active',
        paymobConfigured: !!PAYMOB_API_KEY
    });
});

/**
 * PAYMOB: Initiate Payment
 */
app.post('/api/paymob/initiate', async (req, res) => {
    try {
        if (!PAYMOB_API_KEY) throw new Error("Paymob API Key not configured on server");

        const { bookingId, amount, userDetails } = req.body;
        const amountCents = Math.round(amount * 100);

        // 1. Authenticate
        const authResponse = await axios.post('https://accept.paymob.com/api/auth/tokens', {
            api_key: PAYMOB_API_KEY
        });
        const token = authResponse.data.token;

        // 2. Order Registration
        const orderResponse = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: token,
            delivery_needed: "false",
            amount_cents: amountCents,
            currency: "EGP",
            items: [],
            merchant_order_id: bookingId 
        });
        const orderId = orderResponse.data.id;

        // Update DB with initial payment info
        if (db) {
            await db.ref(`bookings/${bookingId}`).update({
                paymobOrderId: orderId,
                paymentStatus: 'INITIATED'
            });
        }

        // 3. Payment Key Request
        const billingData = {
            apartment: "NA", 
            email: "user@church.com", 
            floor: "NA", 
            first_name: userDetails.name ? userDetails.name.split(' ')[0] : "User", 
            street: "NA", 
            building: "NA", 
            phone_number: userDetails.phone || "01000000000", 
            shipping_method: "NA", 
            postal_code: "NA", 
            city: "Cairo", 
            country: "EG", 
            last_name: userDetails.name ? (userDetails.name.split(' ').slice(1).join(' ') || "Member") : "Member", 
            state: "NA"
        };

        const keyResponse = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
            auth_token: token,
            amount_cents: amountCents,
            expiration: 3600, 
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
        return res.status(500).json({ success: false, error: "Payment initiation failed: " + error.message });
    }
});

/**
 * PAYMOB: Webhook
 */
app.post('/api/paymob/webhook', async (req, res) => {
    try {
        const { obj, type, hmac } = req.body;
        
        if (type !== 'TRANSACTION') return res.status(200).send();

        // HMAC Verification
        if (PAYMOB_HMAC_SECRET) {
            const {
                amount_cents, created_at, currency, error_occured, has_parent_transaction,
                id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
                is_standalone_payment, is_voided, order, owner, pending, source_data, success
            } = obj;

            // Paymob's specific lexical ordering
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
                console.error("⚠️ HMAC Mismatch! Request might be fake.");
                return res.status(403).send(); 
            }
        }

        const isSuccess = obj.success;
        const bookingId = obj.order.merchant_order_id;
        
        if (db && bookingId) {
            if (isSuccess) {
                // Auto-approve and mark as paid
                await db.ref(`bookings/${bookingId}`).update({
                    status: 'APPROVED', 
                    paymentStatus: 'PAID',
                    amountPaid: obj.amount_cents / 100,
                    paymobTransactionId: obj.id
                });
                
                // Optional: Send ticket immediately if phone is registered
                // This logic is best kept separate or triggered here if needed
                console.log(`💰 Booking ${bookingId} Paid & Approved.`);
            } else {
                await db.ref(`bookings/${bookingId}`).update({
                    paymentStatus: 'FAILED'
                });
                console.log(`❌ Booking ${bookingId} Payment Failed.`);
            }
        }

        res.status(200).send();
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send();
    }
});

// Send Telegram Approval
app.post('/api/send-approval', async (req, res) => {
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    if (!db) return res.status(503).json({ success: false, reason: 'db_error', error: 'Database Disconnected.' });

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        const cleanPhone = normalizePhone(phone);
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) return res.json({ success: false, reason: 'user_not_found', error: 'User needs to start bot' });

        const message = `🎫 <b>تذكرة دخول مؤتمر</b>\n👤 <b>${userName}</b>\n📅 ${conferenceTitle}\n📍 ${date}\n#️⃣ رقم الحجز: <code>${bookingId}</code>`;
        const qrBuffer = await QRCode.toBuffer(bookingId, { width: 400 });
        await bot.sendPhoto(chatId, qrBuffer, { caption: message, parse_mode: 'HTML' });
        
        return res.json({ success: true, chatId });
    } catch (error) {
        console.error("Send Error:", error);
        if (error.response?.body?.error_code === 403) return res.json({ success: false, reason: 'bot_blocked' });
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 6. Serve React Frontend (Static Files) ---
app.use(express.static(path.join(__dirname, '../dist')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// --- 7. Start Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
