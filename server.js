
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
 * Final Version - Robust Connection
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. تهيئة التطبيق وإعدادات CORS (أهم خطوة للاتصال) ---
const app = express();

// السماح بالاتصال من أي مكان (لحل مشكلة Network Error)
app.use(cors({
    origin: true, 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token'],
    credentials: true
}));

// التعامل مع طلبات Preflight
app.options('*', cors());
app.use(bodyParser.json());

// --- 2. إعدادات البيئة ---
const PORT = process.env.PORT || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// --- 3. تهيئة Firebase (مع معالجة مشاكل التنسيق) ---
let db = null;
console.log("🔄 Server Starting... Initializing Firebase...");

try {
    if (!admin.apps.length) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            try {
                let rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
                // إصلاح مشاكل التنسيق الشائعة في Railway
                if (rawJson.includes('\\n')) {
                    rawJson = rawJson.replace(/\\n/g, '\n');
                }
                // إزالة المسافات الزائدة وإصلاح علامات التنصيص
                rawJson = rawJson.trim();
                if (rawJson.startsWith('"') && rawJson.endsWith('"')) {
                     rawJson = JSON.parse(rawJson);
                }

                const serviceAccount = JSON.parse(rawJson);
                
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    databaseURL: FIREBASE_DB_URL
                });
                db = admin.database();
                console.log("✅ Firebase Connected Successfully!");
            } catch (err) {
                console.error("❌ CRITICAL: Firebase JSON Error. Please check Railway Variables.", err.message);
            }
        } else {
            console.warn("⚠️ Warning: FIREBASE_SERVICE_ACCOUNT is missing in Railway Variables.");
        }
    } else {
        db = admin.database();
    }
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
}

// --- 4. تهيئة البوت ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// تجاهل أخطاء البوت الشائعة لتجنب توقف السيرفر
bot.on('polling_error', (error) => {
    // console.log(`Bot Error (Ignored): ${error.message}`);
});

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
    if (!db) return;
    const cleanPhone = normalizePhone(phone);
    try {
        await db.ref(`telegram_users/${cleanPhone}`).set(chatId.toString());
        bot.sendMessage(chatId, `👋 أهلاً ${firstName}!\n✅ تم تفعيل حسابك برقم: ${cleanPhone}\nستصلك التذاكر هنا.`);
    } catch (e) {
        console.error("Save User Error:", e);
    }
};

// استقبال جهات الاتصال
bot.on('contact', async (msg) => {
    if (msg.contact && msg.contact.phone_number) {
        await saveUserToFirebase(msg.chat.id, msg.contact.phone_number, msg.chat.first_name || 'User');
    }
});

bot.onText(/\/start$/, async (msg) => {
    bot.sendMessage(msg.chat.id, "أهلاً بك! اضغط الزر بالأسفل لتفعيل استلام التذاكر 👇", {
        reply_markup: {
            keyboard: [[{ text: "📱 مشاركة رقمي", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// --- 6. نقاط الاتصال (API Endpoints) ---

// فحص بسيط للتأكد أن السيرفر يعمل
app.get('/', (req, res) => {
    res.send(`Server is Running! 🚀 DB Status: ${db ? 'Connected ✅' : 'Not Connected ❌'}`);
});

// فحص صحة السيرفر من لوحة التحكم
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        db: db ? 'connected' : 'disconnected',
        time: new Date().toISOString()
    });
});

// إرسال التذكرة
app.post('/api/send-approval', async (req, res) => {
    // التحقق من مفتاح الأمان
    if (req.headers['x-admin-token'] !== SERVER_SECRET_KEY) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { phone, userName, conferenceTitle, date, bookingId } = req.body;

        if (!db) return res.status(503).json({ success: false, error: 'Database not connected' });
        if (!phone) return res.status(400).json({ success: false, error: 'Phone missing' });

        // البحث عن معرف شات التيليجرام
        const cleanPhone = normalizePhone(phone);
        const snapshot = await db.ref(`telegram_users/${cleanPhone}`).once('value');
        const chatId = snapshot.val();

        if (!chatId) {
            return res.json({ success: false, reason: 'user_not_found', error: 'User needs to start bot' });
        }

        // إرسال التذكرة
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
        return res.status(500).json({ success: false, error: error.message });
    }
});

// تشغيل السيرفر
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
