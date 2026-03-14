import fs from 'fs';
import { parse } from 'csv-parse/sync';

export async function parseCsvFile(filePath) {
  const content = await fs.promises.readFile(filePath);
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
  return records;
}

