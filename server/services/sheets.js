import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
const CRED_FILE = path.join(DATA_DIR, 'google_service_account.json');

function getGoogleAuthFromEnv() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
  }
  // Handle escaped newlines from env
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getGoogleAuthFromSavedFile() {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const json = JSON.parse(raw);
    const clientEmail = json.client_email;
    const privateKey = json.private_key;
    if (!clientEmail || !privateKey) return null;
    return new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } catch {
    return null;
  }
}

function getGoogleAuth() {
  const saved = getGoogleAuthFromSavedFile();
  if (saved) return saved;
  return getGoogleAuthFromEnv();
}

export async function getSheetsClient() {
  const auth = getGoogleAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

export async function readRange({ spreadsheetId, range, valueRenderOption = 'UNFORMATTED_VALUE' }) {
  if (!spreadsheetId || !range) throw new Error('spreadsheetId and range are required');
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption,
  });
  return res.data.values || [];
}

export async function appendRows({ spreadsheetId, range, rows, valueInputOption = 'RAW' }) {
  if (!spreadsheetId || !range) throw new Error('spreadsheetId and range are required');
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption,
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return res.data;
}

export function getSavedCredentialsInfo() {
  try {
    if (!fs.existsSync(CRED_FILE)) return { exists: false };
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const json = JSON.parse(raw);
    return { exists: true, client_email: json.client_email || null };
  } catch {
    return { exists: false };
  }
}

export async function updateRange({ spreadsheetId, range, values, valueInputOption = 'RAW' }) {
  if (!spreadsheetId || !range) throw new Error('spreadsheetId and range are required');
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption,
    requestBody: { values },
  });
  return res.data;
}

export async function listSheets({ spreadsheetId }) {
  if (!spreadsheetId) throw new Error('spreadsheetId is required');
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = (resp.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
  return titles;
}


