
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
 * Final Version - Robust Connection, Diagnostics & Bot Logic
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

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
const PORT = process.env.PORT || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// --- 3. تهيئة Firebase ---
let db = null;
let firebaseError = null; // لتخزين سبب الخطأ وعرضه لك

console.log("🔄 Server Starting...");

try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
                
                // محاولة تنظيف النص من الشوائب الشائعة عند النسخ
                if (typeof rawJson === 'string') {
                    rawJson = rawJson.trim();
                    if (rawJson.startsWith("'") && rawJson.endsWith("'")) {
                        rawJson = rawJson.slice(1, -1);
                    }
                    if (rawJson.startsWith('"') && rawJson.endsWith('"') && !rawJson.includes('{')) {
                        rawJson = JSON.parse(rawJson);
                    }
                }

                // محاولة تحويل النص إلى كائن JSON
                let serviceAccount = typeof rawJson === 'object' ? rawJson : JSON.parse(rawJson);

                // إصلاح private_key إذا كان يحتوي على \n كنص
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
                firebaseError = `JSON Parsing Error: ${err.message}. Check Railway Variable format.`;
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

// --- 4. تهيئة البوت ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on('polling_error', () => {}); // منع توقف السيرفر بسبب أخطاء الشبكة

// --- 5. وظائف مساعدة ---
const normalizePhone = (phone) => {
    if (!phone) return '';
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('20')) p = p.substring(2);
    if (p.startsWith('0')) p = p.substring(1);
    return p;
};

// حفظ المستخدم عند مشاركة جهة الاتصال
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

// استقبال جهات الاتصال (Contact)
bot.on('contact', async (msg) => {
    if (msg.contact && msg.contact.phone_number) {
        await saveUserToFirebase(msg.chat.id, msg.contact.phone_number, msg.chat.first_name || 'User');
    }
});

// استقبال أمر /start
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

// --- 6. نقاط الاتصال (API) ---

// الصفحة الرئيسية: تعرض تقرير الحالة
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
                <p><strong>Bot Status:</strong> Active ✅ (Listening for /start)</p>
                ${firebaseError ? `<div style="background: #ffebee; color: #c62828; padding: 10px; border-radius: 5px; margin-top: 10px;">
                    <strong>Error Details:</strong><br/>
                    ${firebaseError}
                </div>` : ''}
                <p><strong>Port:</strong> ${PORT}</p>
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
        time: new Date().toISOString()
    });
});

app.post('/api/send-approval', async (req, res) => {
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (!db) {
        return res.status(503).json({ 
            success: false, 
            reason: 'db_error', 
            error: 'Server Database Disconnected.' 
        });
    }

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;
        
        // البحث عن معرف شات التيليجرام
        const cleanPhone = normalizePhone(phone);
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) {
            console.log(`User not found for phone: ${cleanPhone}`);
            return res.json({ success: false, reason: 'user_not_found', error: 'User needs to start bot and share contact' });
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
        
        console.log(`Ticket sent to ${cleanPhone} (ChatID: ${chatId})`);
        return res.json({ success: true, chatId });

    } catch (error) {
        console.error("Send Error:", error);
        // التعامل مع حالات حظر البوت
        if (error.response && error.response.body && error.response.body.error_code === 403) {
             return res.json({ success: false, reason: 'bot_blocked', error: 'User blocked the bot' });
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
