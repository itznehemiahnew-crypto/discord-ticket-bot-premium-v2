const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TICKETS_PATH = path.join(DATA_DIR, 'tickets.json');

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ guilds: {} }, null, 2));
  }

  if (!fs.existsSync(TICKETS_PATH)) {
    fs.writeFileSync(TICKETS_PATH, JSON.stringify([], null, 2));
  }
}

function readJson(filePath, fallback) {
  ensureStorage();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureStorage();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getGuildConfig(guildId) {
  const config = readJson(CONFIG_PATH, { guilds: {} });
  const current = config.guilds[guildId] || {};

  return {
    prefix: current.prefix || process.env.BOT_PREFIX || '!',
    supportRoleId: current.supportRoleId || '',
    adminRoleId: current.adminRoleId || '',
    ticketCategoryId: current.ticketCategoryId || '',
    archiveCategoryId: current.archiveCategoryId || '',
    logChannelId: current.logChannelId || '',
    panelChannelId: current.panelChannelId || '',
    ticketCounter: current.ticketCounter || 1,
    autoCloseMinutes: current.autoCloseMinutes || 0,
    reminderMinutes: current.reminderMinutes || 0,
    enabledFeatures: {
      transcript: current.enabledFeatures?.transcript ?? true,
      autoClose: current.enabledFeatures?.autoClose ?? false,
      reminders: current.enabledFeatures?.reminders ?? false,
      surveys: current.enabledFeatures?.surveys ?? false
    }
  };
}

function saveGuildConfig(guildId, config) {
  const db = readJson(CONFIG_PATH, { guilds: {} });
  db.guilds[guildId] = config;
  writeJson(CONFIG_PATH, db);
}

function getTickets(guildId) {
  const tickets = readJson(TICKETS_PATH, []);
  return tickets.filter(ticket => ticket.guildId === guildId);
}

function saveTickets(tickets) {
  writeJson(TICKETS_PATH, tickets);
}

function createTicketEntry(guildId, data) {
  const allTickets = readJson(TICKETS_PATH, []);
  allTickets.push({ guildId, ...data });
  saveTickets(allTickets);
}

function updateTicket(guildId, ticketId, updater) {
  const allTickets = readJson(TICKETS_PATH, []);
  const updated = allTickets.map(ticket => {
    if (ticket.guildId === guildId && ticket.ticketId === ticketId) {
      return { ...ticket, ...updater(ticket) };
    }
    return ticket;
  });
  saveTickets(updated);
}

function getTicketByChannel(guildId, channelId) {
  const allTickets = readJson(TICKETS_PATH, []);
  return allTickets.find(ticket => ticket.guildId === guildId && ticket.channelId === channelId) || null;
}

module.exports = {
  getGuildConfig,
  saveGuildConfig,
  getTickets,
  createTicketEntry,
  updateTicket,
  getTicketByChannel,
  ensureStorage
};
