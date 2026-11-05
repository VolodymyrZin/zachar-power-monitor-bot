const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// Змінні середовища
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TARGET_HOST = process.env.TARGET_HOST;

// Налаштування моніторингу
const CHECK_INTERVAL = 60_000; // перевірка кожні 60 секунд
const REQUEST_TIMEOUT = 5_000; // таймаут запиту — 5 секунд
const REQUIRED_ATTEMPTS = 3; // скільки разів поспіль має підтвердитися зміна

// Перевіряємо наявність налаштувань
if (!BOT_TOKEN || !CHAT_ID || !TARGET_HOST) {
  throw new Error('Не задано BOT_TOKEN, CHAT_ID або TARGET_HOST!');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Поточний стан: null — ще невідомий
let isOnline = null;

// Час останньої підтвердженої зміни стану
let lastChangeTime = new Date();

// Лічильники послідовних перевірок
let successCount = 0;
let failureCount = 0;

// Перевірка доступності роутера
async function checkConnection() {
  try {
    await axios.get(TARGET_HOST, {
      timeout: REQUEST_TIMEOUT,
    });

    return true;
  } catch (error) {
    console.log(`Перевірка не пройшла: ${error.message}`);
    return false;
  }
}

// Надсилання повідомлення в Telegram
async function sendNotification(message) {
  try {
    await bot.sendMessage(CHAT_ID, message, {
      parse_mode: 'HTML',
    });
  } catch (error) {
    console.error('Помилка надсилання повідомлення:', error.message);
  }
}

// Форматування тривалості
function getDuration(startTime) {
  const diffMs = Date.now() - startTime.getTime();

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours} год ${minutes} хв`;
}

// Обробка підтвердженої зміни стану
async function changeStatus(newStatus) {
  const duration = getDuration(lastChangeTime);

  if (newStatus) {
    await sendNotification(
      `💡 <b>Світло увімкнули!</b>\nСвітла не було: ${duration}`
    );
  } else {
    await sendNotification(
      `⚡️ <b>Світло вимкнули!</b>\nСвітло було: ${duration}`
    );
  }

  isOnline = newStatus;
  lastChangeTime = new Date();

  console.log(`Новий стан: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
}

// Основна перевірка
async function checkLight() {
  const connectionIsAvailable = await checkConnection();

  if (connectionIsAvailable) {
    successCount++;
    failureCount = 0;
  } else {
    failureCount++;
    successCount = 0;
  }

  // Перша перевірка: визначаємо початковий стан без повідомлення
  if (isOnline === null) {
    if (successCount >= REQUIRED_ATTEMPTS) {
      isOnline = true;
      lastChangeTime = new Date();
      console.log('Початковий стан: ONLINE');
    } else if (failureCount >= REQUIRED_ATTEMPTS) {
      isOnline = false;
      lastChangeTime = new Date();
      console.log('Початковий стан: OFFLINE');
    }

    return;
  }

  // Підтверджуємо вимкнення світла
  if (isOnline && failureCount >= REQUIRED_ATTEMPTS) {
    await changeStatus(false);
    successCount = 0;
    failureCount = 0;
  }

  // Підтверджуємо увімкнення світла
  if (!isOnline && successCount >= REQUIRED_ATTEMPTS) {
    await changeStatus(true);
    successCount = 0;
    failureCount = 0;
  }
}

// Послідовний запуск перевірок
async function startMonitoring() {
  try {
    await checkLight();
  } catch (error) {
    console.error('Помилка моніторингу:', error.message);
  } finally {
    setTimeout(startMonitoring, CHECK_INTERVAL);
  }
}

console.log('Power Monitor Bot started...');
startMonitoring();
