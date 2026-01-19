
/**
 * Church Conference Server
 * Dedicated Backend Entry Point
 */

import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// --- Setup Directory Paths for ESM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- إعدادات ---
const PORT = process.env.PORT || 3001;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8520598013:AAG42JgQICMNO5HlI1nZQcisH0ecwE6aVRA';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://mutamaraty-default-rtdb.firebaseio.com';
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || "CHURCH_CONF_SECURE_2025";

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

    // السماح بالطلبات العامة للملفات الثابتة أو الصفحة الرئيسية
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
        console.log(`[Polling Error]: ${error.message}`);
    }
});

// --- وظائف مساعدة ---
const normalizePhone = (phone) => {
    if (!phone) return '';
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('20')) p = p.substring(2);
    if (p.startsWith('0')) p = p.substring(1);
    return p;
};

const findChatIdByPhone = async (phone) => {
    try {
        const searchKey = normalizePhone(phone);
        const response = await axios.get(`${FIREBASE_DB_URL}/telegram_users.json`);
        const users = response.data || {};

        let foundChatId = null;
        Object.keys(users).forEach(dbPhone => {
            if (normalizePhone(dbPhone) === searchKey) {
                foundChatId = users[dbPhone];
            }
        });
        return foundChatId;
    } catch (error) {
        console.error('Database Error:', error.message);
        return null;
    }
};

const saveUserToFirebase = async (chatId, phone, firstName) => {
    const cleanPhone = phone.replace(/\s/g, '').trim();
    try {
        await axios.put(`${FIREBASE_DB_URL}/telegram_users/${cleanPhone}.json`, JSON.stringify(chatId.toString()));
        
        const welcomeMessage = `
👋 <b>سلام ونعمة يا ${firstName}</b>
أهلاً بك في خدمة مؤتمرات كنيستنا!

✅ <b>تم تفعيل حسابك بنجاح</b>
رقم الهاتف: ${cleanPhone}

🎉 ستصلك تذاكر المؤتمرات هنا فور قبول حجزك من الإدارة.

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
    await bot.sendMessage(chatId, `سلام ونعمة يا ${firstName}، أهلاً بك في بوت خدمة المؤتمرات.`);
});

bot.on('contact', async (msg) => {
    if (msg.contact && msg.contact.phone_number) {
        await saveUserToFirebase(msg.chat.id, msg.contact.phone_number, msg.chat.first_name || 'User');
    }
});

// --- API Endpoints ---

app.get('/', (req, res) => {
    res.send('Church Conference API Server is Running 🚀');
});

app.get('/api/test', (req, res) => {
    res.json({ status: 'Server is working fine!' });
});

app.post('/api/send-approval', authenticateRequest, async (req, res) => {
    const { phone, userName, conferenceTitle, date, bookingId } = req.body;

    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    const chatId = await findChatIdByPhone(phone);

    if (!chatId) {
        return res.status(404).json({ error: 'User not registered on Telegram bot' });
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

        return res.json({ success: true });
    } catch (error) {
        console.error('❌ Telegram Send Error:', error.message);
        return res.status(500).json({ error: 'Failed to send message' });
    }
});

// Serve Static Files (Optional: If you copy 'dist' here)
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
📂 Location: ${__dirname}
--------------------------------------------------
    `);
});
