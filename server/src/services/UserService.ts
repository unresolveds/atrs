import { User, UserRole, UserStatus, hashPassword } from '../models/User';
import { Store } from '../models/Store';
import { Product } from '../models/Product';
import { Activity } from '../models/Activity';
import { Version } from '../models/Version';
import { ProductMarketing } from '../models/ProductMarketing';
import createHttpError from '../utils/httpError';
import { notificationManager } from './NotificationManager';
import { ProductService } from './ProductService';
import { ActivityService } from './ActivityService';
import { deleteMediaFiles } from '../utils/fileUtils';
import type { StreamEvent } from '../utils/sseStream';
import type { AuthUser } from '../types/auth';

export class UserService {
  async listUsers(query: any) {
    const filter: any = {};
    // Coerce to string + validate against the enums so an object like
    // ?status[$ne]=active can't inject a Mongo operator into the query.
    const status = typeof query.status === 'string' ? query.status : undefined;
    const role = typeof query.role === 'string' ? query.role : undefined;
    if (status && ['pending', 'active', 'suspended'].includes(status)) filter.status = status;
    if (role && ['admin', 'user'].includes(role)) filter.role = role;
    const users = await User.find(filter).sort({ createdAt: -1 });
    return users.map((u) => u.toJSON());
  }

  private async getEditableUser(id: string) {
    const user = await User.findById(id);
    if (!user) throw createHttpError(404, 'User not found');
    if (user.isRoot) {
      throw createHttpError(403, 'The root administrator account cannot be modified');
    }
    return user;
  }

  async setStatus(id: string, status: UserStatus) {
    const user = await this.getEditableUser(id);
    const oldStatus = user.status;
    user.status = status;
    await user.save();

    if (oldStatus !== status) {
      notificationManager.sendToUser(id, 'access-change', {
        userId: id,
        status: status,
        message: status === 'active'
          ? 'Your registration has been approved and activated. You now have full access.'
          : 'Your account access has been suspended by an administrator.',
      });
    }

    return user.toJSON();
  }

  async approve(id: string) {
    return this.setStatus(id, 'active');
  }

  async suspend(id: string) {
    return this.setStatus(id, 'suspended');
  }

  async reactivate(id: string) {
    return this.setStatus(id, 'active');
  }

  /**
   * Admin-driven password reset. Sets a one-time password for a non-root user:
   * they can sign in with it once, but are then forced to choose their own
   * password. Also clears any pending reset request.
   */
  async resetPassword(id: string, newPassword: string) {
    const user = await this.getEditableUser(id); // blocks root, 404 if missing
    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = true;
    user.passwordResetRequested = false;
    user.passwordResetRequestedAt = undefined;
    user.passwordChangedAt = new Date(); // invalidates the user's existing JWTs
    await user.save();

    // Let the user know (if they're connected) that their access changed.
    notificationManager.sendToUser(id, 'access-change', {
      userId: id,
      message: 'Your password was reset by an administrator. Sign in with the temporary password and choose a new one.',
    });

    return { id };
  }

  async setRole(id: string, role: UserRole) {
    const user = await this.getEditableUser(id);
    const oldRole = user.role;
    user.role = role;
    await user.save();

    if (oldRole !== role) {
      notificationManager.sendToUser(id, 'access-change', {
        userId: id,
        role: role,
        message: `Your account role has been updated to ${role} by an administrator.`,
      });
    }

    return user.toJSON();
  }

  async deleteUser(id: string) {
    const user = await this.getEditableUser(id);
    await user.deleteOne();
    return { id };
  }

  /**
   * Streaming delete of a user and, when they are the last member, their store.
   *
   * Products belong to the store, not to the person, so removing a member must
   * not take the store's data with them — their colleagues still need it. Only
   * when the departing user is the sole remaining member does the store and
   * everything in it go too. An owner who still has colleagues is refused:
   * ownership has to be handed over first, because silently promoting someone
   * or silently deleting a working store are both worse than an error message.
   */
  async deleteUserCascade(
    id: string,
    actingUser: AuthUser,
    ctx: { emit: (e: StreamEvent) => void; isCancelled: () => boolean }
  ) {
    const { emit, isCancelled } = ctx;
    const target = await this.getEditableUser(id); // throws on root / not-found

    const storeId = target.storeId ? String(target.storeId) : null;
    // Everyone else still in this store. Their work is the reason the cascade
    // must not fire just because one person is leaving.
    const remaining = storeId
      ? await User.countDocuments({ storeId, _id: { $ne: target._id } })
      : 0;

    if (storeId && remaining > 0) {
      if (target.storeRole === 'owner') {
        throw createHttpError(
          409,
          `${target.name} owns a store with ${remaining} other member${remaining === 1 ? '' : 's'}. ` +
          'Transfer ownership before deleting the account.',
        );
      }
      // A member leaving: remove the account, leave the store's data alone.
      emit({ type: 'info', step: 'start', message: `Removing "${target.name}" from the store...` });
      await target.deleteOne();
      emit({
        type: 'success', step: 'user',
        message: `✓ Account removed. The store's products and history are untouched.`,
      });
      return { productsDeleted: 0, errors: [] as string[], cancelled: false };
    }

    emit({ type: 'info', step: 'start', message: `Deleting "${target.name}" and all of their data...` });

    const productService = new ProductService();
    // Scoped to the store, not the person: a store's products are shared, and
    // this path only runs when nobody is left to share them with.
    const products = storeId ? await Product.find({ storeId }, 'name').lean() : [];
    emit({ type: 'info', step: 'scan', message: `Found ${products.length} product(s) in this store` });

    let productsDeleted = 0;
    const errors: string[] = [];
    let cancelled = false;

    for (let i = 0; i < products.length; i++) {
      if (isCancelled()) { cancelled = true; break; }
      const p = products[i] as any;
      const pctx = { itemIndex: i + 1, totalItems: products.length };
      try {
        const counts = await productService.getCascadeCounts(p._id.toString());
        emit({ ...pctx, type: 'info', step: 'product', message: `Removing "${p.name}" + ${counts.activities} activities, ${counts.versions} versions, ${counts.marketing} marketing & assets...` });
        await productService.deleteProduct(p._id.toString(), actingUser);
        productsDeleted++;
        emit({ ...pctx, type: 'success', step: 'product', label: p.name, message: `✓ Removed "${p.name}"` });
      } catch (err: any) {
        errors.push(`${p.name}: ${err.message}`);
        emit({ ...pctx, type: 'error', step: 'product', message: `✗ Failed "${p.name}": ${err.message}` });
      }
    }

    if (!cancelled) {
      // Any activities still tagged to this user (e.g. product already gone).
      const orphanActs = storeId ? await Activity.find({ storeId }, '_id').lean() : [];
      if (orphanActs.length > 0) {
        emit({ type: 'info', step: 'orphans', message: `Removing ${orphanActs.length} orphaned activit${orphanActs.length !== 1 ? 'ies' : 'y'} & media...` });
        const activityService = new ActivityService();
        await activityService.bulkDeleteActivities(orphanActs.map((a: any) => a._id.toString()), actingUser);
        emit({ type: 'success', step: 'orphans', message: `✓ Removed orphaned activities` });
      }

      // Orphaned marketing docs: clean their media files, then the docs.
      const orphanMkt = !storeId ? [] : await ProductMarketing.find(
        { storeId },
        'trailerVideo tutorialVideo thumbnailImage keyFeatures screenshots demos'
      ).lean();
      if (orphanMkt.length > 0) {
        const urls: (string | undefined)[] = [];
        for (const m of orphanMkt as any[]) {
          urls.push(m.trailerVideo, m.tutorialVideo, m.thumbnailImage);
          m.keyFeatures?.forEach((kf: any) => urls.push(kf.mediaUrl));
          m.screenshots?.forEach((s: any) => urls.push(s.url));
          m.demos?.forEach((d: any) => urls.push(d.icon));
        }
        deleteMediaFiles(urls.filter(Boolean) as string[]);
        await ProductMarketing.deleteMany({ storeId });
        emit({ type: 'success', step: 'orphans', message: `✓ Removed orphaned marketing data` });
      }

      // Orphaned version rows.
      await Version.deleteMany({ storeId });

      emit({ type: 'info', step: 'user', message: `Removing user account...` });
      await target.deleteOne();
      emit({ type: 'success', step: 'user', message: `✓ User account removed` });
    }

    emit({
      type: errors.length ? 'warn' : 'success',
      step: 'summary',
      message: `${cancelled ? 'Stopped' : 'Done'}: ${productsDeleted} product(s) removed, ${errors.length} error(s)`,
    });
    return { productsDeleted, errors, cancelled };
  }

  /**
   * Hands a store's ownership to another of its members.
   *
   * Nothing is rewritten: products, activities and versions belong to the store
   * and stay exactly where they are. Only the store's `ownerId` and the two
   * users' roles change. The previous behaviour — rewriting every document from
   * one user to another — existed because documents were owned by people; under
   * stores it would be a no-op at best and a cross-store data move at worst.
   */
  async transferStoreOwnership(fromUserId: string, toUserId: string) {
    const [from, to] = await Promise.all([User.findById(fromUserId), User.findById(toUserId)]);
    if (!from) throw createHttpError(404, 'Current owner not found');
    if (!to) throw createHttpError(404, 'Target user not found');
    if (!from.storeId) throw createHttpError(400, 'That user does not belong to a store.');
    if (from.storeRole !== 'owner') throw createHttpError(400, 'That user does not own their store.');
    if (String(to.storeId) !== String(from.storeId)) {
      // Handing a store to an outsider would silently pull them out of their own.
      throw createHttpError(400, 'The new owner must already be a member of the same store.');
    }
    if (String(from._id) === String(to._id)) {
      throw createHttpError(400, 'That user already owns the store.');
    }

    const store = await Store.findById(from.storeId);
    if (!store) throw createHttpError(404, 'Store not found');

    store.ownerId = to._id as never;
    to.storeRole = 'owner';
    // Demoted rather than removed: the outgoing owner keeps working in the store.
    from.storeRole = 'manager';
    await Promise.all([store.save(), to.save(), from.save()]);

    return {
      storeId: String(store._id),
      storeName: store.name,
      newOwnerId: String(to._id),
      previousOwnerRole: from.storeRole,
    };
  }
}
