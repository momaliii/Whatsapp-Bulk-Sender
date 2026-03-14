import multer from 'multer';
import path from 'path';
import { UPLOAD_DIR, DATA_DIR } from '../config/index.js';

// General file upload
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const name = `${Date.now()}_${base}${ext}`;
    cb(null, name);
  },
});
export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Document upload for AI analysis
const documentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}_${cleanName}`);
  },
});

export const documentUpload = multer({ 
  storage: documentStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only TXT, PDF, DOC, and DOCX files are allowed.'));
    }
  }
});

// Google Credentials upload
export const credUpload = multer({ 
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, DATA_DIR),
    filename: (_req, _file, cb) => cb(null, 'google_service_account.json')
  })
});

