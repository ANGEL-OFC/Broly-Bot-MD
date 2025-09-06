process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';

import './config.js';
import './plugins/_content.js';
import { createRequire } from 'module';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'process';
import * as ws from 'ws';
import fs, { mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import NodeCache from 'node-cache';
import { gataJadiBot } from './plugins/jadibot-serbot.js';
import { makeInMemoryStore, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Low, JSONFile } from 'lowdb';
import Pino from 'pino';
import Datastore from '@seald-io/nedb';
import store from './lib/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(__dirname);
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

// --- Rutas y archivos ---
global.creds = 'creds.json';
global.authFile = 'NovaBot-MD';        // Cambio de GataBotSession a NovaBot-MD
global.authFileJB = 'ANGEL-OFC';       // Cambio de GataJadiBot a ANGEL-OFC
global.rutaBot = join(__dirname, global.authFile);
global.rutaJadiBot = join(__dirname, global.authFileJB);
const respaldoDir = join(__dirname, 'BackupSession');
const credsFile = join(global.rutaBot, global.creds);

if (!fs.existsSync(global.rutaJadiBot)) mkdirSync(global.rutaJadiBot);
if (!fs.existsSync(respaldoDir)) mkdirSync(respaldoDir);

// --- Base de datos ---
const dbPath = join(__dirname, 'database');
if (!fs.existsSync(dbPath)) mkdirSync(dbPath);

const collections = {
  users: new Datastore({ filename: join(dbPath, 'users.db'), autoload: true }),
  chats: new Datastore({ filename: join(dbPath, 'chats.db'), autoload: true }),
  settings: new Datastore({ filename: join(dbPath, 'settings.db'), autoload: true }),
  msgs: new Datastore({ filename: join(dbPath, 'msgs.db'), autoload: true }),
  sticker: new Datastore({ filename: join(dbPath, 'sticker.db'), autoload: true }),
  stats: new Datastore({ filename: join(dbPath, 'stats.db'), autoload: true }),
};

Object.values(collections).forEach(db => db.setAutocompactionInterval(300000));
global.db = { data: { users: {}, chats: {}, settings: {}, msgs: {}, sticker: {}, stats: {} } };

// --- Funciones de respaldo y restauración ---
const backupCreds = async () => {
  if (!fs.existsSync(credsFile)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const newBackup = join(respaldoDir, `creds-${timestamp}.json`);
  fs.copyFileSync(credsFile, newBackup);

  const backups = readdirSync(respaldoDir)
    .filter(f => f.startsWith('creds-') && f.endsWith('.json'))
    .sort((a, b) => fs.statSync(join(respaldoDir, a)).mtimeMs - fs.statSync(join(respaldoDir, b)).mtimeMs);

  while (backups.length > 3) {
    const oldest = backups.shift();
    unlinkSync(join(respaldoDir, oldest));
  }
};

const restoreCreds = async () => {
  const backups = readdirSync(respaldoDir)
    .filter(f => f.startsWith('creds-') && f.endsWith('.json'))
    .sort((a, b) => fs.statSync(join(respaldoDir, b)).mtimeMs - fs.statSync(join(respaldoDir, a)).mtimeMs);
  if (!backups.length) return;
  const latest = join(respaldoDir, backups[0]);
  fs.copyFileSync(latest, credsFile);
};

// --- Conexión con Baileys ---
const { state, saveState } = await useMultiFileAuthState(global.authFile);
const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const userDevicesCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const { version } = await fetchLatestBaileysVersion();

const connectionOptions = {
  logger: Pino({ level: 'silent' }),
  printQRInTerminal: true,
  auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: 'fatal' }).child({ level: 'fatal' })) },
  markOnlineOnConnect: false,
  generateHighQualityLinkPreview: true,
  syncFullHistory: false,
  getMessage: async (key) => {
    try {
      const jid = jidNormalizedUser(key.remoteJid);
      const msg = await store.loadMessage(jid, key.id);
      return msg?.message || '';
    } catch { return ''; }
  },
  msgRetryCounterCache,
  userDevicesCache,
  defaultQueryTimeoutMs: undefined,
  cachedGroupMetadata: (jid) => global.conn?.chats[jid] ?? {},
  version,
  keepAliveIntervalMs: 55000,
  maxIdleTimeMs: 60000,
};

global.conn = makeWASocket(connectionOptions);

// --- QR o código de 8 dígitos automático ---
if (!fs.existsSync(credsFile)) {
  if (process.env.BOT_PHONE_NUMBER) {
    // Si hay número de teléfono, generar código de 8 dígitos automáticamente
    let addNumber = process.env.BOT_PHONE_NUMBER.replace(/\D/g, '');
    setTimeout(async () => {
      try {
        let codeBot = await global.conn.requestPairingCode(addNumber);
        codeBot = codeBot?.match(/.{1,4}/g)?.join('-') || codeBot;
        console.log(chalk.bold.white(chalk.bgMagenta('Código de vinculación ANGEL-OFC:')), chalk.bold.white(codeBot));
      } catch (err) {
        console.error('Error generando código de 8 dígitos:', err);
      }
    }, 2000);
  } else {
    // Mostrar QR en terminal si no hay número definido
    console.log(chalk.bold.green('Escanea el QR para vincular NovaBot-MD'));
  }
}

// --- Respaldo periódico ---
setInterval(async () => {
  await backupCreds();
  console.log('[♻️] Respaldo periódico realizado.');
}, 5 * 60 * 1000);

// --- Manejo de desconexión ---
global.conn.ev.on('connection.update', async (update) => {
  const { connection, lastDisconnect } = update;
  if (connection === 'close') {
    restoreCreds();
    console.log('Conexión cerrada, restaurando sesión NovaBot-MD...');
    await global.reloadHandler(true).catch(console.error);
  }
});

// --- Reload handler ---
let handler = await import('./handler.js');
global.reloadHandler = async (restartConn) => {
  try {
    const H = await import(`./handler.js?update=${Date.now()}`).catch(console.error);
    if (Object.keys(H || {}).length) handler = H;
  } catch (e) { console.error(e); }

  if (restartConn) {
    const oldChats = global.conn.chats;
    try { global.conn.ws.close(); } catch { }
    global.conn.ev.removeAllListeners();
    global.conn = makeWASocket(connectionOptions, { chats: oldChats });
  }
};

// --- Guardar base de datos antes de cerrar ---
async function gracefulShutdown() {
  if (global.db) await global.db.save();
  console.log('Guardando base de datos antes de cerrar...');
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

console.log('NovaBot-MD iniciado correctamente. Esperando vinculación si es necesario...');