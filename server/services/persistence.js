import fs from 'fs';
import path from 'path';
import { savedFlows, userTags } from './state.js';
import { DATA_DIR } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function saveFlowsToFile() {
  try {
    const obj = Object.fromEntries(savedFlows);
    fs.writeFileSync(path.join(DATA_DIR, 'flows.json'), JSON.stringify(obj, null, 2));
  } catch (e) { logger.error({ err: e.message }, 'Failed to save flows'); }
}

export function saveUserTagsToFile() {
  try {
    const obj = {};
    for (const [k, v] of userTags) obj[k] = Array.from(v);
    fs.writeFileSync(path.join(DATA_DIR, 'user_tags.json'), JSON.stringify(obj, null, 2));
  } catch (e) { logger.error({ err: e.message }, 'Failed to save user tags'); }
}

export function loadFlows() {
    try {
        const flowsFile = path.join(DATA_DIR, 'flows.json');
        if (fs.existsSync(flowsFile)) {
            const data = JSON.parse(fs.readFileSync(flowsFile, 'utf8'));
            for (const [id, flow] of Object.entries(data)) {
                savedFlows.set(id, flow);
            }
        }
    } catch (e) { logger.error({ err: e.message }, 'Failed to load flows'); }
}

export function loadUserTags() {
    try {
        const userTagsFile = path.join(DATA_DIR, 'user_tags.json');
        if (fs.existsSync(userTagsFile)) {
            const data = JSON.parse(fs.readFileSync(userTagsFile, 'utf8'));
            for (const [phone, tags] of Object.entries(data)) {
                userTags.set(phone, new Set(tags));
            }
        }
    } catch (e) { logger.error({ err: e.message }, 'Failed to load user tags'); }
}

