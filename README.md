# Surprise Test (Free Path)

## Stack
- Frontend: React + Vite, hosted on Firebase Hosting
- Backend API: Express + Firestore, hosted on Vercel Hobby (free)
- Database: Cloud Firestore (Spark free tier)
- Excel: exceljs

## Install
1. `npm --prefix client install`
2. `npm --prefix functions install`

## Local test
- `npm run local:firebase`

## Deploy backend (Vercel, free)
1. Import `functions` folder as a Vercel project (Root Directory: `functions`).
2. Add environment variable in Vercel:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = full JSON of Firebase service account key.
3. Deploy.
4. Copy backend URL (example: `https://surprise-test-api.vercel.app`).

## Deploy frontend (Firebase Hosting)
1. Create `client/.env.production` with:
   - `VITE_API_BASE=https://<your-vercel-backend>/api`
2. Build and deploy:
   - `npm --prefix client run build`
   - `firebase deploy --only hosting:main`
