import { Request, Response, NextFunction } from 'express';
import { UserService } from '../services/UserService';
import { User } from '../models/User';
import { runStreamJob } from '../utils/sseStream';

const userService = new UserService();

export const listUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await userService.listUsers(req.query);
    res.status(200).json(users);
  } catch (error) {
    next(error);
  }
};

export const approveUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await userService.approve(req.params.id as string));
  } catch (error) {
    next(error);
  }
};

export const suspendUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await userService.suspend(req.params.id as string));
  } catch (error) {
    next(error);
  }
};

export const reactivateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await userService.reactivate(req.params.id as string));
  } catch (error) {
    next(error);
  }
};

export const setUserRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    res.status(200).json(await userService.setRole(req.params.id as string, role));
  } catch (error) {
    next(error);
  }
};

export const deleteUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reassignTo } = req.query as { reassignTo?: string };
    if (reassignTo) {
      await userService.transferStoreOwnership(req.params.id as string, reassignTo);
    }
    res.status(200).json(await userService.deleteUser(req.params.id as string));
  } catch (error) {
    next(error);
  }
};

export const resetUserPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (password.length > 200) {
      return res.status(400).json({ message: 'Password is too long' });
    }
    const result = await userService.resetPassword(req.params.id as string, password);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const deleteUserStream = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  // Pre-flight checks return clean JSON before the SSE stream opens.
  const target = await User.findById(id);
  if (!target) return res.status(404).json({ message: 'User not found' });
  if (target.isRoot) return res.status(403).json({ message: 'The root administrator account cannot be deleted' });

  await runStreamJob(req, res, (ctx) => userService.deleteUserCascade(id, req.user!, ctx));
};

export const transferStoreOwnership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { toUserId } = req.body as { toUserId: string };
    const result = await userService.transferStoreOwnership(req.params.id as string, toUserId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
