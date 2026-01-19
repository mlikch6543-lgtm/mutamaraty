
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
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

// --- Setup Directory Paths for ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- إعدادات البيئة ---
const PORT = process.env.PORT || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

// --- تهيئة Firebase Admin (هام جداً للاتصال بقاعدة البيانات) ---
try {
    if (!admin.apps.length) {
        // محاولة قراءة Service Account من متغيرات البيئة
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            // إذا كان النص JSON string
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } else {
            console.warn("⚠️ Warning: FIREBASE_SERVICE_ACCOUNT not found in environment variables.");
        }

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: FIREBASE_DB_URL
            });
            console.log("✅ Firebase Admin Initialized Successfully");
        }
    }
} catch (error) {
    console.error("❌ Firebase Init Error:", error.message);
}

const db = admin.apps.length ? admin.database() : null;

// تهيئة التطبيق والبوت
const app = express();
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Middleware
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token']
}));

app.use(bodyParser.json());

// Logging Middleware
app.use((req, res, next) => {
    console.log(`🔔 Incoming Request: ${req.method} ${req.url}`);
    next();
});

// Security Middleware
const authenticateRequest = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    
    if (req.method === 'OPTIONS') return next();
    if (req.method === 'GET' && !req.path.startsWith('/api')) return next();

    if (token === SERVER_SECRET_KEY) {
        next();
    } else {
        console.log(`⛔ Unauthorized access attempt from: ${req.ip}`);
        res.status(403).json({ error: 'Forbidden: Invalid Token' });
    }
};

console.log('🚀 Server is starting...');

// --- معالجة أخطاء البوت ---
bot.on('polling_error', (error) => {
    if (error.code !== 'ETELEGRAM' && !error.message.includes('409')) {
        console.log(`[Bot Polling Error]: ${error.message}`);
    }
});

bot.on('message', (msg) => {
    console.log(`📩 Received message from [${msg.from.first_name}]: ${msg.text}`);
});

// --- وظائف مساعدة ---
const normalizePhone = (phone) => {
    if (!phone) return '';
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('20')) p = p.substring(2);
    if (p.startsWith('0')) p = p.substring(1);
    return p;
};

// البحث في قاعدة البيانات باستخدام Admin SDK
const findChatIdByPhone = async (phone) => {
    if (!db) {
        console.error("❌ Database not initialized");
        return null;
    }

    try {
        const searchKey = normalizePhone(phone);
        // البحث المباشر باستخدام المفتاح (أسرع بكثير)
        const snapshot = await db.ref(`telegram_users/${searchKey}`).once('value');
        const chatId = snapshot.val();
        
        console.log(`🔍 Searching for phone: ${searchKey}, Found ChatID: ${chatId}`);
        return chatId;
    } catch (error) {
        console.error('Database Read Error:', error.message);
        return null;
    }
};

// الحفظ في قاعدة البيانات باستخدام Admin SDK
const saveUserToFirebase = async (chatId, phone, firstName) => {
    if (!db) return;

    const cleanPhone = normalizePhone(phone);
    try {
        await db.ref(`telegram_users/${cleanPhone}`).set(chatId.toString());
        console.log(`✅ Saved user: ${firstName} - ${cleanPhone} (ChatID: ${chatId})`);

        const welcomeMessage = `
👋 <b>سلام ونعمة يا ${firstName}</b>
أهلاً بك في خدمة مؤتمرات كنيستنا!

✅ <b>تم تفعيل حسابك وتأكيد رقم هاتفك</b>
رقم الهاتف المسجل: ${phone}

🎉 بمجرد قبول حجزك من الإدارة، ستصلك التذكرة هنا فوراً.

🙏 <b>صلوا من أجل الخدمة</b>
        `.trim();

        bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Save Error:', error);
        bot.sendMessage(chatId, "حدث خطأ أثناء حفظ بياناتك، حاول مرة أخرى.");
    }
};

// --- أوامر البوت ---
bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match[1];
    if (payload && payload.length >= 10) {
        await saveUserToFirebase(chatId, payload, msg.chat.first_name || 'User');
    }
});

bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.chat.first_name || 'يا مبارك';
    
    await bot.sendMessage(chatId, `سلام ونعمة يا ${firstName} ❤️\nأهلاً بك في بوت خدمة المؤتمرات.\n\n👇 اضغط على الزر بالأسفل لمشاركة رقم هاتفك وتفعيل التذاكر`, {
        reply_markup: {
            keyboard: [[{ text: "📱 تفعيل حسابي (مشاركة الرقم)", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

bot.on('contact', async (msg) => {
    if (msg.contact && msg.contact.phone_number) {
        await saveUserToFirebase(msg.chat.id, msg.contact.phone_number, msg.chat.first_name || 'User');
    }
});

// --- API Endpoints ---

app.get('/', (req, res) => {
    const dbStatus = db ? "Connected ✅" : "Disconnected ❌ (Check Service Account)";
    res.send(`Church Conference API Server is Running 🚀<br>DB Status: ${dbStatus}`);
});

app.post('/api/send-approval', authenticateRequest, async (req, res) => {
    const { phone, userName, conferenceTitle, date, bookingId } = req.body;

    console.log(`📤 Processing Approval for: ${userName} (${phone})`);

    if (!phone) return res.status(400).json({ error: 'Phone is required', success: false });

    // التحقق من قاعدة البيانات
    if (!db) {
        return res.status(500).json({ success: false, reason: 'db_error', error: 'Database not connected on server' });
    }

    const chatId = await findChatIdByPhone(phone);

    if (!chatId) {
        console.log(`⚠️ User not found in Telegram mappings for phone: ${phone}`);
        return res.json({ success: false, reason: 'user_not_found', error: 'User has not started the bot' });
    }

    const message = `
🎉 <b>تم تأكيد حجزك بنعمة ربنا</b>

👤 <b>الاسم:</b> ${userName}
📅 <b>المؤتمر:</b> ${conferenceTitle}
📍 <b>التاريخ:</b> ${date}

<b>رقم الحجز:</b> <code>${bookingId}</code>

👇 <b>يرجى إظهار الباركود عند الدخول</b>
    `.trim();

    try {
        const qrBuffer = await QRCode.toBuffer(bookingId, {
            width: 400,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        });
        
        await bot.sendPhoto(chatId, qrBuffer, { 
            caption: message, 
            parse_mode: 'HTML' 
        }, {
            filename: 'ticket.png',
            contentType: 'image/png'
        });

        console.log(`✅ Ticket sent successfully to ChatID: ${chatId}`);
        return res.json({ success: true, chatId: chatId });
    } catch (error) {
        console.error('❌ Telegram Send Error:', error.message);
        // التحقق مما إذا كان الخطأ بسبب حظر البوت
        if (error.message.includes('403') || error.message.includes('blocked')) {
             return res.json({ success: false, reason: 'bot_blocked', error: 'User blocked the bot' });
        }
        return res.status(500).json({ success: false, reason: 'telegram_error', error: 'Failed to send message via Telegram' });
    }
});

// Serve Static Files
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(distPath, 'index.html'));
        }
    });
}

app.listen(PORT, () => {
    console.log(`
--------------------------------------------------
🌐 Server running on Port ${PORT}
--------------------------------------------------
    `);
});
