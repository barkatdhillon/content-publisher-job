#!/bin/sh
set -e

gcloud builds submit --tag gcr.io/content-publisher-8b3af/content-publisher-job

gcloud run deploy content-publisher-job --image gcr.io/content-publisher-8b3af/content-publisher-job --platform managed --region us-central1 --no-allow-unauthenticated
