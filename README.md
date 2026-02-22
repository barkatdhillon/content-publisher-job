# content-publisher-job

## Environment

- `FIREBASE_PROJECT_ID` (optional; defaults to `GOOGLE_CLOUD_PROJECT`)
- `PORT` (optional; defaults to `8080`)

Authentication uses Application Default Credentials.

## Run locally

1. Ensure you have a service account JSON and set `GOOGLE_APPLICATION_CREDENTIALS`.
2. Install deps and run:

```bash
npm install
npm start
```

## API

- `POST /api/content/upload`
- `POST /api/content/publish`

## Deploy to Cloud Run
1. Build and deploy:

```bash
gcloud builds submit --tag gcr.io/content-publisher-8b3af/content-publisher-job
gcloud run deploy content-publisher-job --image gcr.io/content-publisher-8b3af/content-publisher-job --platform managed --region us-central1 --no-allow-unauthenticated
