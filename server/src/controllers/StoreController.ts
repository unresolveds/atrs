import { Request, Response, NextFunction } from 'express';
import { StoreService } from '../services/StoreService';
import { UserService } from '../services/UserService';

/**
 * Store endpoints.
 *
 * The role rules live in StoreService (and ultimately in `assertStoreRole`), not
 * here — a controller that re-implemented them would be a second place for the
 * authority model to drift.
 *
 * The Ollama key is never serialised back; `ollamaCloudKeySet` says whether one
 * is stored so the UI can show "saved" without the value leaving the server.
 */

const storeService = new StoreService();
const userService = new UserService();

/** Strips write-only secrets before a store goes over the wire. */
function present(store: any) {
  if (!store) return null;
  const doc = typeof store.toObject === 'function' ? store.toObject() : { ...store };
  const intelligence = { ...(doc.intelligence || {}) };
  const hasKey = !!intelligence.ollamaCloudKey;
  delete intelligence.ollamaCloudKey;
  return { ...doc, intelligence: { ...intelligence, ollamaCloudKeySet: hasKey } };
}

export const createStore = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await storeService.createStore(req.body, req.user!);
    res.status(201).json(present(store));
  } catch (error) { next(error); }
};

/**
 * The caller's store. Answers 200 with `null` rather than 404 when they have
 * none — "you have no store yet" is a normal state for a new account, and the
 * client routes on it to the create screen.
 */
export const getMyStore = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await storeService.getMyStore(req.user!);
    res.status(200).json(store ? present(store) : null);
  } catch (error) { next(error); }
};

export const updateStore = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const store = await storeService.updateStore(req.body, req.user!);
    res.status(200).json(present(store));
  } catch (error) { next(error); }
};

export const listMembers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await storeService.listMembers(req.user!));
  } catch (error) { next(error); }
};

export const addMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, role } = req.body;
    res.status(201).json(await storeService.addMember(email, role, req.user!));
  } catch (error) { next(error); }
};

export const setMemberRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await storeService.setMemberRole(String(req.params.memberId), req.body.role, req.user!));
  } catch (error) { next(error); }
};

export const removeMember = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await storeService.removeMember(String(req.params.memberId), req.user!));
  } catch (error) { next(error); }
};

export const transferOwnership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await userService.transferStoreOwnership(req.user!.id, req.body.toUserId));
  } catch (error) { next(error); }
};

/** Platform-admin support views. */
export const listAllStores = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json(await storeService.listAllStores(req.user!));
  } catch (error) { next(error); }
};

export const moveProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, toStoreId } = req.body;
    res.status(200).json(await storeService.moveProduct(productId, toStoreId, req.user!));
  } catch (error) { next(error); }
};
