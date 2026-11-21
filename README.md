# Reachly by Infofitsserve Consultant Services

`web/` = website (GitHub Pages). `server/` = API (Google Cloud Run + Firestore). Pushing to `main` deploys both.

## 1. GitHub
1. Create a private repo, push this folder to `main`.
2. Settings > Pages > Source: **GitHub Actions**.
3. Settings > Variables > Actions: `SITE_URL` = your site URL (e.g. https://YOURUSER.github.io/REPO or your custom domain), `API_URL` = your Cloud Run URL (set after step 2.5).

## 2. Google Cloud (project with billing on)
1. `gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com`
2. `gcloud firestore databases create --location=asia-south1`
3. Secrets (never commit them): for each of PAYU_KEY, PAYU_SALT, JWT_SECRET (long random), ANTHROPIC_API_KEY:
   `printf 'VALUE' | gcloud secrets create NAME --data-file=-`
4. Give the Cloud Run runtime service account roles `Secret Manager Secret Accessor` and `Cloud Datastore User`.
5. Create a deploy service account with roles `Cloud Run Admin`, `Service Account User`, `Cloud Build Editor`, `Artifact Registry Writer`, `Storage Admin`. Set up Workload Identity Federation for your repo (see google-github-actions/auth docs). Add GitHub secrets `GCP_WIF_PROVIDER` and `GCP_SA`.
6. Run the "Deploy API" workflow, copy the service URL into the `API_URL` variable, then run "Deploy website".

## 3. Before going live
- Add an email/SMS sender in `deliver()` in server/server.js (OTP is not delivered until you do).
- PayU: test with PAYU_URL=https://test.payu.in/_payment and test keys first; the workflow uses the live URL.
- Set real plan prices; replace placeholders in Terms/Privacy (address, email, grievance officer, refund policy, court city).
- Social ad connections (Meta, Google Ads, LinkedIn, X) are stubs: each needs an approved developer app.
- Cloud Run URL is public by design; endpoints are protected by login tokens. Add rate limiting before launch.
