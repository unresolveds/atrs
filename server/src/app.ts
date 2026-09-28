import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { customLogger } from './middlewares/logger';
import connectDB from './config/db';
import { errorHandler } from './middlewares/errorHandler';
import { requireAuth, requireActive, requireAdmin, assertJwtSecretAtBoot } from './middlewares/auth';
import { seedAndMigrate } from './scripts/seedAndMigrate';
import { isServerless, loadAppConfigCache } from './utils/appConfig';

import productRoutes from './routes/productRoutes';
import storeRoutes from './routes/storeRoutes';
import activityRoutes from './routes/activityRoutes';
import reportRoutes from './routes/reportRoutes';
import uploadRoutes from './routes/uploadRoutes';
import auditLogRoutes from './routes/auditLogRoutes';
import versionRoutes from './routes/versionRoutes';
import issueRoutes from './routes/issueRoutes';
import configRoutes from './routes/configRoutes';
import mediaRoutes from './routes/mediaRoutes';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import notificationRoutes from './routes/notificationRoutes';
import jobRoutes from './routes/jobRoutes';
import githubRoutes from './routes/githubRoutes';
import readmeToolsRoutes from './routes/readmeToolsRoutes';
import publicRoutes from './routes/publicRoutes';
import featureRequestRoutes from './routes/featureRequestRoutes';
import streakRoutes from './routes/streakRoutes';
import changelogGenRoutes from './routes/changelogGenRoutes';
import aiRoutes from './routes/aiRoutes';
import intelligenceRoutes from './routes/intelligenceRoutes';
import competitorRoutes from './routes/competitorRoutes';
import { exportAllData } from './controllers/ExportController';

// On Vercel env vars are injected by the platform; locally they come from the
// repo-root .env file. dotenv is a no-op when the file is missing.
if (!isServerless()) {
  const envPath = path.resolve(__dirname, '../../.env');
  const result = dotenv.config({ path: envPath });
  console.log(`[server]: Loading .env from ${envPath}`);
  if (result.error) {
    console.error('[server]: Dotenv parsing error:', result.error);
  }
}

const app: Express = express();

// Behind Vercel's proxy the client IP arrives via X-Forwarded-For; without
// trust proxy, express-rate-limit would key every request to the proxy IP.
if (isServerless()) {
  app.set('trust proxy', 1);
}

// Security headers
app.use(helmet({
  // Allow cross-origin loading of static assets (uploaded images/videos)
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS allow-list. CLIENT_ORIGIN is a comma-separated list of allowed origins;
// defaults to the vite dev origins. Requests with no Origin header (curl,
// server-to-server, same-origin) are always allowed.
const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://192.168.0.199:5173'];
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGIN
    ? process.env.CLIENT_ORIGIN.split(',')
    : defaultOrigins
  )
    .map((o) => o.trim())
    .filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      // Don't throw on a disallowed (or `null`, e.g. iframe form-navigation)
      // origin — just omit the CORS headers. The browser still blocks
      // cross-origin XHR/fetch reads (no Access-Control-Allow-Origin), but
      // plain navigations like the readme-validator iframe's form POST proceed.
      return callback(null, false);
    },
    credentials: true,
  })
);

// Rate limiting on the API surface.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
});
app.use('/api', apiLimiter);

// HTTP request logging
app.use(customLogger);

// Body parsing. Uploads go through multer, so JSON/urlencoded stay small.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static files for uploads (local-storage provider only; on Vercel media
// lives in Cloudflare R2 and is served from its public URL).
app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

// Public auth routes (register / login / me)
app.use('/api/auth', authRoutes);

// Public: reverse proxy for the WordPress.org readme validator so it can be
// embedded in an <iframe> (it blocks framing). No auth — an iframe navigation
// can't send the JWT header, and it only proxies a public page.
app.use('/api/tools', readmeToolsRoutes);

// Public: read-only endpoints for the hosted changelog page (/changelog/:id).
// No auth — owners opt a product in via its publicChangelogEnabled flag.
app.use('/api/public', publicRoutes);

// Authenticated + active-account routes
app.use('/api/stores', requireAuth, requireActive, storeRoutes);
app.use('/api/products', requireAuth, requireActive, productRoutes);
app.use('/api/activities', requireAuth, requireActive, activityRoutes);
app.use('/api/reports', requireAuth, requireActive, reportRoutes);
app.use('/api/upload', requireAuth, requireActive, uploadRoutes);
app.use('/api/media', requireAuth, requireActive, mediaRoutes);
app.use('/api/audit-logs', requireAuth, requireActive, auditLogRoutes);
app.use('/api/versions', requireAuth, requireActive, versionRoutes);
app.use('/api/issues', requireAuth, requireActive, issueRoutes);
app.use('/api/feature-requests', requireAuth, requireActive, featureRequestRoutes);
app.use('/api/streak', requireAuth, requireActive, streakRoutes);
app.use('/api/jobs', requireAuth, requireActive, jobRoutes);
app.use('/api/github', requireAuth, requireActive, githubRoutes);
app.use('/api/changelog-gen', requireAuth, requireActive, changelogGenRoutes);
app.use('/api/ai', requireAuth, requireActive, aiRoutes);
app.use('/api/intelligence', requireAuth, requireActive, intelligenceRoutes);
app.use('/api/competitors', requireAuth, requireActive, competitorRoutes);
app.use('/api/notifications', notificationRoutes);

// Admin-only routes
app.use('/api/users', requireAuth, requireActive, requireAdmin, userRoutes);
app.use('/api/config', requireAuth, requireActive, requireAdmin, configRoutes);
app.get('/api/export', requireAuth, requireActive, requireAdmin, exportAllData);

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'ATRS API is running' });
});

// Error handling
app.use(errorHandler);

/**
 * One-time startup work shared by the local server and the Vercel function:
 * JWT sanity check, MongoDB connection, config-cache load, seed/migrations.
 *
 * Memoized so concurrent serverless invocations share one attempt; a failed
 * attempt clears the memo so the next request can retry instead of caching
 * the failure for the life of the instance.
 */
let bootPromise: Promise<void> | null = null;

export function bootstrap(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      assertJwtSecretAtBoot();
      // Serverless cold starts should fail fast instead of retrying with
      // backoff — the platform retries by giving the next request a new boot.
      await connectDB(isServerless() ? 1 : undefined);
      await loadAppConfigCache();
      await seedAndMigrate().catch((err) =>
        console.error('[server]: seedAndMigrate failed:', err)
      );
    })();
    bootPromise.catch(() => {
      bootPromise = null;
    });
  }
  return bootPromise;
}

export default app;
