# MediSage

MediSage is a chat-first medical-education assistant. The React/Vite client is
hosted on Firebase Hosting, Firebase Authentication supports anonymous guests
and optional accounts, and the JSON API runs as an Express function on Vercel
Hobby.

> MediSage is educational software, not a diagnostic system or substitute for a
> qualified professional.

## Architecture

- `/`, `/app`, and chat links open the chatbot immediately. Login appears only
  after the user selects **Sign in**.
- Firebase Anonymous Authentication creates the guest identity. Email/password,
  forgot-password, and Google Sign-in remain available.
- Every chat and translation request carries a Firebase ID token. The Vercel
  backend verifies its signature, issuer, audience, and subject using Google's
  public Firebase keys; no service-account credential is stored on Vercel.
- The backend retrieves real prepared records from
  [`ruslanmv/ai-medical-dataset`](https://huggingface.co/datasets/ruslanmv/ai-medical-dataset).
- PDF, DOCX, CSV, XLSX, text, Markdown, and practical image OCR are processed in
  the browser. Original files and Base64 file data are never sent to Vercel.
- Relevant local chunks are sent as bounded JSON context. Attachment sources
  use `DOC1`, `DOC2`; Hugging Face sources use `HF1`, `HF2`.

## Local setup

Requirements: Node.js 20.19+, npm, and Python 3.9+ only when regenerating the
dataset.

```bash
npm install
cp .env.example .env
npm run dev
```

The checked-in prepared dataset is
`server/data/hf_medical_knowledge.jsonl`. Regenerate it when needed:

```bash
python3 -m venv .venv
.venv/bin/pip install datasets
npm run prepare:dataset
```

The Vite client runs at `http://localhost:5173`; the legacy local Express
listener runs at `http://localhost:8080`. `vercel dev` exercises the production
serverless entry.

## Environment

Vercel server environment variables:

```env
OPENROUTER_API_KEY=your_server_only_key
OPENROUTER_MODEL=openrouter/free
HF_DATASET_NAME=ruslanmv/ai-medical-dataset
HF_DATASET_FILE=server/data/hf_medical_knowledge.jsonl
HF_DATASET_REQUIRED=true
FIREBASE_PROJECT_ID=medi-sage
CORS_ORIGINS=https://medi-sage.web.app,https://medi-sage.firebaseapp.com,http://localhost:5173
```

Firebase/Vite production environment:

```env
VITE_API_BASE_URL=https://YOUR-VERCEL-BACKEND.vercel.app
VITE_AUTH_ENABLED=true
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=medi-sage.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=medi-sage
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_GOOGLE_SIGN_IN_ENABLED=true
```

Firebase web values are public client configuration. Never put
`OPENROUTER_API_KEY` or any other server secret in a `VITE_*` variable.

In Firebase Console → Authentication → Sign-in method, enable:

- Anonymous
- Email/Password
- Google

Add both Firebase Hosting domains and any custom domain to Authentication's
authorized domains.

## Browser-local attachments

The composer draft owns the selected `File` only while it is being extracted.
After extraction the app creates a stable content-derived attachment ID and
location-preserving chunks:

| Type | Browser parser | Preserved location |
| --- | --- | --- |
| PDF | `pdfjs-dist` | page |
| DOCX | `mammoth` | paragraph section |
| CSV | Papa Parse | row range |
| XLSX | ExcelJS | sheet and row range |
| TXT / Markdown / JSON | `File.text()` | section |
| PNG / JPG / WEBP | Tesseract.js when practical | image |

An attachment can be sent without typed text. Sending clears the composer and
stores lightweight attachment metadata on the sent message, while the
conversation retains extracted chunks locally. Follow-up retrieval reuses the
stable ID and chunks; it does not upload or re-extract the file. Firestore sync
omits chunks, so attachment context is device-local and does not automatically
appear on another device.

At most twelve relevant chunks are sent to `/api/chat`. The Vercel function
accepts JSON only, limits JSON bodies to 256 KB, and exposes no attachment
upload endpoint.

## Vercel API

Entry file: `api/index.js`  
Express app: `server/src/vercelApp.js`

Endpoints:

- `GET /api/health`
- `POST /api/chat`
- `POST /api/translate`

Health returns JSON with the actual prepared dataset load state and record
count. Chat and translation require `Authorization: Bearer <Firebase ID token>`.
All success, validation, CORS, authorization, not-found, and server-error
responses are JSON. The client also rejects HTML/non-JSON API responses.

Deploy after logging into a Vercel account:

```bash
vercel link
vercel env add OPENROUTER_API_KEY production
vercel env add OPENROUTER_MODEL production
vercel env add HF_DATASET_NAME production
vercel env add FIREBASE_PROJECT_ID production
vercel --prod
```

Set the non-secret values shown above. Keep the OpenRouter key only in Vercel's
server environment.

## Firebase Hosting

`firebase.json` serves the Vite SPA only; it has no server/function rewrite.
After setting the real backend URL in `client/.env.production`:

```bash
npm run build
npx firebase-tools deploy --only hosting --project medi-sage
```

## Verification

```bash
npm test
npm run build
```

The automated suite covers local PDF extraction with page locations, stable
attachment IDs, attachment-only sending, composer clearing, extraction-once
follow-ups, Firebase anonymous and registered token verification, real
Hugging Face source objects, HTML-response rejection, Google Sign-in
visibility, production API URL joining, JSON-only routes, and Vercel config.

## Genuine serverless limitations

- Vercel Functions have bounded request bodies, execution time, memory, and
  deployment size. Large source files must remain browser-local.
- Loading the prepared retrieval index on a cold instance adds latency and
  memory use. Instances do not share mutable memory.
- Local chunks persist on the current browser/device; clearing storage or
  switching devices loses that attachment context.
- OCR and large spreadsheet/PDF parsing consume the user's CPU and memory.
  Tesseract language assets may need a first-use download.
- Free OpenRouter model availability, quotas, and latency can change. Firebase
  and Vercel also enforce their own free-tier quotas.
- Do not submit sensitive health information without appropriate privacy,
  consent, retention, security, and clinical/legal review.
