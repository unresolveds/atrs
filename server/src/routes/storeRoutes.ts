import { Router } from 'express';
import * as StoreController from '../controllers/StoreController';
import { validate } from '../middlewares/validate';
import { requireAdmin } from '../middlewares/auth';
import {
  createStoreSchema,
  updateStoreSchema,
  addMemberSchema,
  setMemberRoleSchema,
  memberParamsSchema,
  transferOwnershipSchema,
  moveProductSchema,
} from '../schemas/store.schema';

const router = Router();

// Mounted behind requireAuth + requireActive. Role checks happen in the service
// so they cannot drift between the route table and the logic.
router.post('/', validate(createStoreSchema), StoreController.createStore);
router.get('/me', StoreController.getMyStore);
router.patch('/me', validate(updateStoreSchema), StoreController.updateStore);

router.get('/me/members', StoreController.listMembers);
router.post('/me/members', validate(addMemberSchema), StoreController.addMember);
router.patch('/me/members/:memberId', validate(setMemberRoleSchema), StoreController.setMemberRole);
router.delete('/me/members/:memberId', validate(memberParamsSchema), StoreController.removeMember);
router.post('/me/transfer-ownership', validate(transferOwnershipSchema), StoreController.transferOwnership);

// Platform-admin support endpoints. Moving a product needs sight of two stores,
// which only an operator has.
router.get('/all', requireAdmin, StoreController.listAllStores);
router.post('/move-product', requireAdmin, validate(moveProductSchema), StoreController.moveProduct);

export default router;
