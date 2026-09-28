import { Router } from 'express';
import * as UserController from '../controllers/UserController';
import * as AuthController from '../controllers/AuthController';
import rateLimit from 'express-rate-limit';
import { validate } from '../middlewares/validate';
import { registerSchema } from '../schemas/auth.schema';

// Mounted behind requireAuth + requireAdmin in index.ts
const router = Router();


// Strict limiter to slow credential stuffing / brute force on the auth endpoints.
// Tighter than the global /api limiter; only counts failed attempts so a user
// logging in normally is never blocked. Applied to login/register only — /me is
// hit on every app load and stays under the global limiter.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // attempts per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: 'Too many attempts, please try again in a few minutes.' },
});

router.get('/', UserController.listUsers);
router.patch('/:id/approve', UserController.approveUser);
router.patch('/:id/suspend', UserController.suspendUser);
router.patch('/:id/reactivate', UserController.reactivateUser);
router.patch('/:id/role', UserController.setUserRole);
router.post('/:id/reset-password', UserController.resetUserPassword);
router.post('/:id/reassign', UserController.transferStoreOwnership);
router.post('/:id/delete-stream', UserController.deleteUserStream);
router.delete('/:id', UserController.deleteUser);
router.post('/create-user', authLimiter, validate(registerSchema), AuthController.register);

export default router;
