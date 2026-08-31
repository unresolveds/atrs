import http from 'http';
import mongoose from 'mongoose';
import app, { bootstrap } from './app';
import { IntelligenceScheduler } from './services/intelligence/IntelligenceScheduler';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;

// Connect to MongoDB, then ensure the root admin exists and back-fill
// ownership. The server still starts listening while this runs so a slow DB
// doesn't block boot; requests simply fail until the connection is up.
bootstrap().catch((err) => {
  console.error('[server]: Could not establish initial MongoDB connection:', err?.message || err);
});

const server: http.Server = app.listen(port, '0.0.0.0', () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
  IntelligenceScheduler.initialize();
});

// Graceful shutdown: stop accepting connections, then close the DB.
const shutdown = (signal: string) => {
  console.log(`[server]: Received ${signal}, shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      console.error('[server]: Error closing HTTP server:', err);
    } else {
      console.log('[server]: HTTP server closed.');
    }
    IntelligenceScheduler.stop();
    mongoose.connection
      .close(false)
      .then(() => {
        console.log('[server]: MongoDB connection closed.');
        process.exit(0);
      })
      .catch((closeErr) => {
        console.error('[server]: Error closing MongoDB connection:', closeErr);
        process.exit(1);
      });
  });

  // Force-exit if graceful close hangs.
  setTimeout(() => {
    console.error('[server]: Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
