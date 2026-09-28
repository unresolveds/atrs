import { Router, Request, Response } from 'express';
import { requireAuth, requireActive, requireAuthSSE } from '../middlewares/auth';
import { readAppConfig } from '../utils/appConfig';
import { notificationManager } from '../services/NotificationManager';
import { getMyNotifications, markAsRead, markAllAsRead, deleteNotification } from '../controllers/NotificationController';

const router = Router();

router.get('/', requireAuth, requireActive, getMyNotifications);
router.patch('/read-all', requireAuth, requireActive, markAllAsRead);
router.patch('/:id/read', requireAuth, requireActive, markAsRead);
router.delete('/:id', requireAuth, requireActive, deleteNotification);

/**
 * SSE Endpoint for clients to subscribe to real-time notification streams.
 * Expects JWT token either via Authorization header or "?token=<jwt>" query parameter.
 */
router.get('/subscribe', requireAuthSSE, requireActive, (req: Request, res: Response) => {
  const user = req.user!;

  // Configure response headers for Server-Sent Events (SSE)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable output buffering in Nginx / proxy layers
  });

  // Send comment data immediately to flush headers
  res.write(': ok\n\n');

  // Keep connection socket alive and remove default client timeout limits
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);

  // Add client handle to notification dispatcher
  const unsubscribe = notificationManager.addClient(user.id, user.isRoot, res, user.role === 'admin', user.storeId);

  // Unregister user when client closes the socket connection
  req.on('close', () => {
    unsubscribe();
  });
});

/**
 * Authenticated endpoint exposing the admin-configured nested-navigation mode
 * so every user's sidebar can honor it. Falls back to 'expanded'.
 */
router.get('/nav-settings', requireAuth, requireActive, (_req: Request, res: Response) => {
  try {
    const data = readAppConfig();
    let mode = 'expanded';
    if (['expanded', 'collapsed', 'disabled'].includes(data?.navigation?.mode)) {
      mode = data.navigation.mode;
    }
    res.status(200).json({ mode });
  } catch {
    res.status(200).json({ mode: 'expanded' });
  }
});

/**
 * Authenticated endpoint exposing the admin-configured branding (company name,
 * logo, accent color) so non-admins can present a branded report deck.
 */
router.get('/branding', requireAuth, requireActive, (_req: Request, res: Response) => {
  const fallback = { companyName: '', logoUrl: '', accentColor: '', accentDynamic: false, thankYouEnabled: true, thankYouTitle: '', thankYouMessage: '' };
  try {
    const data = readAppConfig();
    res.status(200).json({ ...fallback, ...(data?.branding || {}) });
  } catch {
    res.status(200).json(fallback);
  }
});

/**
 * Public-authenticated endpoint for retrieving current sound settings.
 */
router.get('/sounds', requireAuth, requireActive, (req: Request, res: Response) => {
  try {
    let soundsConfig = {
      enabled: true,
      successSound: 'synth-success',
      deleteSound: 'synth-delete',
      errorSound: 'synth-error',
      notificationSound: 'synth-notification',
      clickSound: 'synth-click',
      volume: 0.5
    };

    const data = readAppConfig();
    if (data?.sounds) {
      soundsConfig = { ...soundsConfig, ...data.sounds };
    }

    res.status(200).json(soundsConfig);
  } catch (error) {
    res.status(200).json({
      enabled: true,
      successSound: 'synth-success',
      deleteSound: 'synth-delete',
      errorSound: 'synth-error',
      notificationSound: 'synth-notification',
      clickSound: 'synth-click',
      volume: 0.5
    });
  }
});

export default router;
