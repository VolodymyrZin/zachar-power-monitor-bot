const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const QUEUE = '17.1';
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const YASNO_URL =
  'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages';
const ALERTS_ENERGY_URL = `https://alerts.energy/kyiv/schedule/kyiv_oblenergo/${QUEUE}/zavtra`;

function loadSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (error) {
    console.error('Помилка читання графіка:', error.message);

    return {
      todayDate: null,
      today: [],
      todayStatus: null,
      tomorrowDate: null,
      tomorrow: [],
      tomorrowStatus: null,
    };
  }
}

function saveSchedule(schedule) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAlertsEnergy() {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data: html } = await axios.get(ALERTS_ENERGY_URL, {
        timeout: 15000,
      });

      const marker = `"queue":"${QUEUE}"`;
      const index = html.indexOf(marker);

      if (index === -1) {
        throw new Error(`Чергу ${QUEUE} не знайдено`);
      }

      const start = html.lastIndexOf('{', index);

      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;

      for (let i = start; i < html.length; i++) {
        const char = html[i];

        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }

        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}') {
          depth--;

          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }

      if (end === -1) {
        throw new Error('Не вдалося визначити межі об’єкта графіка');
      }

      return JSON.parse(html.slice(start, end));
    } catch (error) {
      const status = error.response?.status;

      if (status === 429 && attempt < maxAttempts) {
        const retryAfter = Number(error.response.headers['retry-after']);
        if (Number.isFinite(retryAfter) && retryAfter > 60) {
          throw error;
        }
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 60000)
            : attempt * 30000;

        console.log(
          `Отримано 429. Повторна спроба через ${delay / 1000} секунд`
        );

        await sleep(delay);
        continue;
      }

      throw error;
    }
  }
}
async function fetchYasno() {
  const { data } = await axios.get(YASNO_URL, {
    timeout: 15000,
  });
  const { today, tomorrow } = data[QUEUE];
  return {
    todayDate: today.date,
    today: today.slots,
    todayStatus: today.status,
    tomorrowDate: tomorrow.date,
    tomorrow: tomorrow.slots,
    tomorrowStatus: tomorrow.status,
  };
}

function hasScheduleChanged(newSchedule, oldSchedule) {
  return (
    newSchedule.todayDate !== oldSchedule.todayDate ||
    JSON.stringify(newSchedule.today) !== JSON.stringify(oldSchedule.today) ||
    newSchedule.todayStatus !== oldSchedule.todayStatus ||
    newSchedule.tomorrowStatus !== oldSchedule.tomorrowStatus ||
    newSchedule.tomorrowDate !== oldSchedule.tomorrowDate ||
    JSON.stringify(newSchedule.tomorrow) !==
      JSON.stringify(oldSchedule.tomorrow)
  );
}

function formatOutages(hours) {
  if (!hours || hours.length === 0) {
    return 'Графік ще не опублікований';
  }

  const slots = [];

  for (const hour of hours) {
    slots.push(hour === 1 || hour === 2);
    slots.push(hour === 1 || hour === 3);
  }

  const outages = [];
  let start = null;

  for (let i = 0; i <= slots.length; i++) {
    if (slots[i] && start === null) start = i;

    if ((!slots[i] || i === slots.length) && start !== null) {
      const end = i;

      const formatTime = slot => {
        const minutes = slot * 30;
        const hour = Math.floor(minutes / 60);
        const minute = minutes % 60;

        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      };

      outages.push(`${formatTime(start)}–${formatTime(end)}`);
      start = null;
    }
  }

  return outages.length ? outages.join(', ') : 'Відключень немає';
}
function formatYasnoOutages(slots, status) {
  if (status === 'WaitingForSchedule') return 'Графік ще не опублікований';
  if (!slots || slots.length === 0) {
    return 'Графік ще не опублікований';
  }
  const plannedOutages = slots.filter(slot => slot.type === 'Definite');
  if (plannedOutages.length === 0) {
    return 'Відключень немає';
  }
  return plannedOutages
    .map(slot => {
      return `${formatTime(slot.start)} - ${formatTime(slot.end)}`;
    })
    .join(', ');
}
function formatDate(date) {
  const [year, month, day] = date.slice(0, 10).split('-');
  return [day, month, year].join('.');
}
async function fetchSchedule() {
  try {
    const yasno = await fetchYasno();
    return { ...yasno, source: 'yasno' };
  } catch (error) {
    console.warn('YASNO недоступний:', error.message);

    const alertsEnergy = await fetchAlertsEnergy();
    return { ...alertsEnergy, source: 'alerts-energy' };
  }
}
function formatTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function updateSchedule(bot) {
  const previousSchedule = loadSchedule();
  const newSchedule = await fetchSchedule();

  if (!hasScheduleChanged(newSchedule, previousSchedule)) {
    console.log('Змін у графіку немає');
    return;
  }

  const updatedSchedule = {
    todayDate: newSchedule.todayDate,
    today: newSchedule.today,
    todayStatus: newSchedule.todayStatus,
    tomorrowDate: newSchedule.tomorrowDate,
    tomorrow: newSchedule.tomorrow,
    tomorrowStatus: newSchedule.tomorrowStatus,
  };

  const isFirstRun = !previousSchedule.todayDate;

  if (isFirstRun) {
    saveSchedule(updatedSchedule);
    console.log('Початковий графік збережено без сповіщення');
    return;
  }
  const formatOutagesBySource =
    newSchedule.source === 'yasno' ? formatYasnoOutages : formatOutages;
  const message =
    `📅 <b>Оновлено графік відключень</b>\n\n` +
    `Сьогодні (${formatDate(updatedSchedule.todayDate)}):\n` +
    `${formatOutagesBySource(updatedSchedule.today, updatedSchedule.todayStatus)}\n\n` +
    `Завтра (${formatDate(updatedSchedule.tomorrowDate)}):\n` +
    `${formatOutagesBySource(updatedSchedule.tomorrow, updatedSchedule.tomorrowStatus)}`;

  await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
  saveSchedule(updatedSchedule);

  console.log('Графік оновлено, повідомлення надіслано');
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('Не задано BOT_TOKEN або CHAT_ID!');
  }

  const bot = new TelegramBot(BOT_TOKEN, { polling: false });

  console.log('Перевірка графіка запущена');

  try {
    await updateSchedule(bot);
  } catch (error) {
    console.error('Статус:', error.response?.status);
    console.error('Дані:', error.response?.data);
    console.error('Заголовки:', error.response?.headers);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Критична помилка:', error.message);
  process.exitCode = 1;
});
