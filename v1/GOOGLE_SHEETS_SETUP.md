Google Sheets Integration

Option A: Upload service account JSON (recommended)

Endpoints:
- GET /api/google-credentials → { exists: boolean, client_email?: string }
- POST /api/google-credentials (multipart/form-data, field name: file) → saves to data/google_service_account.json
- DELETE /api/google-credentials → remove saved JSON

Option B: Environment variables (service account):
- GOOGLE_SERVICE_ACCOUNT_EMAIL
- GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY

Notes:
- If setting the private key via shell, ensure newlines are escaped as \n.
- Share your spreadsheet with the service account email (Editor access).

Sheets endpoints

1) Read range
POST /api/google-sheets/read
Body:
{
  "spreadsheetId": "<sheet_id>",
  "range": "Sheet1!A1:D100",
  "valueRenderOption": "UNFORMATTED_VALUE"
}

Response: { "values": [[...], ...] }

2) Append rows
POST /api/google-sheets/append
Body:
{
  "spreadsheetId": "<sheet_id>",
  "range": "Sheet1!A1",
  "rows": [["col1","col2"],["c1","c2"]],
  "valueInputOption": "RAW"
}

Response: Google API append result

Example curl

curl -sS -X POST http://localhost:3000/api/google-sheets/read \
  -H 'Content-Type: application/json' \
  -d '{"spreadsheetId":"<sheet_id>","range":"Sheet1!A1:B10"}' | jq .

curl -sS -X POST http://localhost:3000/api/google-sheets/append \
  -H 'Content-Type: application/json' \
  -d '{"spreadsheetId":"<sheet_id>","range":"Sheet1!A1","rows":[["Hello","World"]]}' | jq .


