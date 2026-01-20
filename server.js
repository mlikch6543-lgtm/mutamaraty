
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
 * Final Version - Robust Connection, Diagnostics, Bot Logic & Paymob Integration
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
// HARDCODED DEFAULTS AS REQUESTED
const PORT = process.env.PORT || 3000; 
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// Paymob Configuration (Egypt)
const PAYMOB_API_KEY = process.env.PAYMOB_API_KEY || "ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SmpiR0Z6Y3lJNklrMWxjbU5vWVc1MElpd2ljSEp2Wm1sc1pWOXdheUk2TVRFeE1UYzBNQ3dpYm1GdFpTSTZJbWx1YVhScFlXd2lmUS5lOW1GcEhOVThVRV9pS2hYdzFIdTJISWQwc2pHMG1lSDUwQ0d5RGwyUm55ZEM2WGVFMTl4R2VIOXRtX1pwcFh0RGNnaGlMQ2VySmxoNUdERjF0Sm40QQ==";
const PAYMOB_INTEGRATION_ID = process.env.PAYMOB_INTEGRATION_ID || "5419269"; 
const PAYMOB_IFRAME_ID = process.env.PAYMOB_IFRAME_ID || "983782";
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || "256D3B8CC68FFB2A11BE0F247EFCDAED";

// --- 3. Firebase Initialization ---
let db = null;
let firebaseError = null;

console.log("🔄 Server Starting...");

try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
                // Handle potential string escaping from environment variables
                if (typeof rawJson === 'string') {
                    rawJson = rawJson.trim();
                    if (rawJson.startsWith("'") && rawJson.endsWith("'")) {
                        rawJson = rawJson.slice(1, -1);
                    }
                    if (rawJson.startsWith('"') && rawJson.endsWith('"') && !rawJson.includes('{')) {
                        rawJson = JSON.parse(rawJson);
                    }
                }
                
                let serviceAccount = typeof rawJson === 'object' ? rawJson : JSON.parse(rawJson);
                
                // Fix newline characters in private key
                if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
                    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                }

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    databaseURL: FIREBASE_DB_URL
                });
                db = admin.database();
                console.log("✅ Firebase Connected Successfully!");
                firebaseError = null;
            } catch (err) {
                console.error("❌ Firebase JSON Parse Error:", err.message);
                firebaseError = `JSON Parsing Error: ${err.message}. Ensure FIREBASE_SERVICE_ACCOUNT is the full JSON object.`;
            }
        } else {
            console.warn("⚠️ Warning: FIREBASE_SERVICE_ACCOUNT is missing.");
            firebaseError = "Missing Environment Variable: FIREBASE_SERVICE_ACCOUNT";
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
        console.log(`✅ Bot registered user: ${cleanPhone} -> ${chatId}`);
    } catch (e) {
        console.error("Save User Error:", e);
        bot.sendMessage(chatId, "❌ حدث خطأ أثناء التسجيل. حاول مرة أخرى لاحقاً.");
    }
};

// Bot Listeners
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
    bot.sendMessage(msg.chat.id, "أهلاً بك في بوت مؤتمرات كنيستنا! ⛪\n\nلضمان استلام التذاكر، يجب ربط حسابك برقم الهاتف المسجل في الحجز.\n\n👇 اضغط على الزر بالأسفل لمشاركة رقمك 👇", opts);
});

// --- 6. API Routes ---

app.get('/', (req, res) => {
    const statusColor = db ? 'green' : 'red';
    const statusText = db ? 'CONNECTED ✅' : 'DISCONNECTED ❌';
    
    res.send(`
    <html>
        <head><title>Church Server Status</title></head>
        <body style="font-family: monospace; padding: 20px; background: #f0f0f0;">
            <div style="background: white; padding: 20px; border-radius: 10px; border-left: 5px solid ${statusColor};">
                <h1>Server Status 🚀</h1>
                <p><strong>Database:</strong> <span style="color: ${statusColor}; font-weight: bold; font-size: 1.2em;">${statusText}</span></p>
                <p><strong>Paymob Integration:</strong> ${PAYMOB_API_KEY ? 'Configured 💳' : 'Not Configured ⚠️'}</p>
                <p><strong>Bot Status:</strong> Active ✅</p>
                <p><strong>Port:</strong> ${PORT}</p>
                ${firebaseError ? `<div style="background: #ffebee; color: #c62828; padding: 10px; border-radius: 5px; margin-top: 10px;">
                    <strong>Error Details:</strong><br/>
                    ${firebaseError}
                </div>` : ''}
                <p><strong>Last Check:</strong> ${new Date().toISOString()}</p>
            </div>
        </body>
    </html>
    `);
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        db: db ? 'connected' : 'disconnected',
        error: firebaseError,
        bot: 'active',
        paymob: !!PAYMOB_API_KEY,
        time: new Date().toISOString()
    });
});

/**
 * PAYMOB: Initiate Payment
 * 1. Auth -> 2. Register Order -> 3. Payment Key -> 4. Return Iframe URL
 */
app.post('/api/paymob/initiate', async (req, res) => {
    if (!PAYMOB_API_KEY || !PAYMOB_INTEGRATION_ID) {
        return res.status(500).json({ success: false, error: 'Paymob is not configured on server.' });
    }

    try {
        const { bookingId, amount, userDetails } = req.body;
        const amountCents = Math.round(amount * 100);

        // 1. Authentication
        const authResponse = await axios.post('https://accept.paymob.com/api/auth/tokens', {
            api_key: PAYMOB_API_KEY
        });
        const token = authResponse.data.token;

        // 2. Register Order
        const orderResponse = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: token,
            delivery_needed: "false",
            amount_cents: amountCents,
            currency: "EGP",
            items: [], // Optional: Add items for detail
            merchant_order_id: bookingId // Use our booking ID as reference
        });
        const orderId = orderResponse.data.id;

        // 3. Save Order ID to Firebase Booking (Important for matching webhook later)
        if (db) {
            await db.ref(`bookings/${bookingId}`).update({
                paymobOrderId: orderId,
                paymentStatus: 'INITIATED'
            });
        }

        // 4. Payment Key Request
        const billingData = {
            apartment: "NA", 
            email: "user@church-app.com", // Placeholder if not collected
            floor: "NA", 
            first_name: userDetails.name.split(' ')[0] || "User", 
            street: "NA", 
            building: "NA", 
            phone_number: userDetails.phone, 
            shipping_method: "NA", 
            postal_code: "NA", 
            city: "Cairo", 
            country: "EG", 
            last_name: userDetails.name.split(' ').slice(1).join(' ') || "Church Member", 
            state: "NA"
        };

        const keyResponse = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
            auth_token: token,
            amount_cents: amountCents,
            expiration: 3600, // 1 Hour
            order_id: orderId,
            billing_data: billingData,
            currency: "EGP",
            integration_id: PAYMOB_INTEGRATION_ID
        });

        const paymentKey = keyResponse.data.token;
        const iframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${paymentKey}`;

        return res.json({ success: true, url: iframeUrl });

    } catch (error) {
        console.error("Paymob Initiate Error:", error.response?.data || error.message);
        return res.status(500).json({ success: false, error: "Payment initiation failed." });
    }
});

/**
 * PAYMOB: Webhook (Processed Transaction Callback)
 * Handles the logic when payment is successful or failed.
 * Security: Validates HMAC.
 */
app.post('/api/paymob/webhook', async (req, res) => {
    const { obj, type, hmac } = req.body;

    // We only care about transaction callbacks
    if (type !== 'TRANSACTION') {
        return res.status(200).send();
    }

    // 1. Verify HMAC (Security)
    if (PAYMOB_HMAC_SECRET && hmac) {
        const {
            amount_cents,
            created_at,
            currency,
            error_occured,
            has_parent_transaction,
            id,
            integration_id,
            is_3d_secure,
            is_auth,
            is_capture,
            is_refunded,
            is_standalone_payment,
            is_voided,
            order,
            owner,
            pending,
            source_data_pan,
            source_data_sub_type,
            source_data_type,
            success,
        } = obj;

        // Order of concatenation matters per Paymob Docs
        const lexString = 
            amount_cents + 
            created_at + 
            currency + 
            error_occured + 
            has_parent_transaction + 
            id + 
            integration_id + 
            is_3d_secure + 
            is_auth + 
            is_capture + 
            is_refunded + 
            is_standalone_payment + 
            is_voided + 
            order.id + 
            owner + 
            pending + 
            source_data_pan + 
            source_data_sub_type + 
            source_data_type + 
            success;

        const calculatedHmac = crypto
            .createHmac('sha512', PAYMOB_HMAC_SECRET)
            .update(lexString)
            .digest('hex');

        if (calculatedHmac !== hmac) {
            console.error("⚠️ Invalid HMAC Signature from Paymob");
            return res.status(403).send('Invalid Hash');
        }
    }

    // 2. Process Transaction
    const success = obj.success;
    const orderId = obj.order.id;
    const transactionId = obj.id;
    const amount = obj.amount_cents / 100;

    console.log(`🔔 Payment Webhook for Order ${orderId}: Success=${success}`);

    if (db && success === true) {
        try {
            // Find booking by Paymob Order ID (merchant_order_id matches our booking ID)
            const bookingId = obj.order.merchant_order_id;

            if (bookingId) {
                await db.ref(`bookings/${bookingId}`).update({
                    status: 'APPROVED', // Auto-approve paid bookings
                    paymentStatus: 'PAID',
                    transactionId: transactionId,
                    amountPaid: amount,
                    updatedAt: new Date().toISOString()
                });
                console.log(`✅ Booking ${bookingId} marked as PAID & APPROVED.`);
                
                // Optional: Send Notification via Bot immediately
                const snapshot = await db.ref(`bookings/${bookingId}`).once('value');
                const booking = snapshot.val();
                if (booking) {
                    try {
                       const userSnap = await db.ref(`telegram_users/${normalizePhone(booking.userPhone)}`).once('value');
                       const chatId = userSnap.val();
                       if (chatId) {
                            const message = `✅ <b>تم تأكيد الحجز بنجاح!</b>\n\nتم استلام دفعة بقيمة <b>${amount} ج.م</b>\nرقم الحجز: ${bookingId}\n\nتذكرتك جاهزة في التطبيق.`;
                            await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
                       }
                    } catch(e) { console.error("Notif Error", e); }
                }
            } else {
                console.warn("⚠️ No merchant_order_id found in callback.");
            }
        } catch (error) {
            console.error("Database Update Error:", error);
            return res.status(500).send();
        }
    } else if (db && success === false) {
         const bookingId = obj.order.merchant_order_id;
         if (bookingId) {
             await db.ref(`bookings/${bookingId}`).update({
                paymentStatus: 'FAILED'
             });
         }
    }

    res.status(200).send();
});

// Admin Notification Endpoint (Existing)
app.post('/api/send-approval', async (req, res) => {
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (!db) {
        return res.status(503).json({ success: false, reason: 'db_error', error: 'Server Database Disconnected.' });
    }

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        const cleanPhone = normalizePhone(phone);
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) {
            return res.json({ success: false, reason: 'user_not_found', error: 'User needs to start bot' });
        }

        const message = `
🎫 <b>تذكرة دخول مؤتمر</b>
👤 <b>${userName}</b>
📅 ${conferenceTitle}
📍 ${date}
#️⃣ رقم الحجز: <code>${bookingId}</code>
        `.trim();

        const qrBuffer = await QRCode.toBuffer(bookingId, { width: 400 });
        await bot.sendPhoto(chatId, qrBuffer, { caption: message, parse_mode: 'HTML' });
        
        return res.json({ success: true, chatId });

    } catch (error) {
        console.error("Send Error:", error);
        if (error.response?.body?.error_code === 403) {
             return res.json({ success: false, reason: 'bot_blocked', error: 'User blocked the bot' });
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
