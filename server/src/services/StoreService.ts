import mongoose from 'mongoose';
import { Store, roleAtLeast, type IStore, type StoreRole } from '../models/Store';
import { User } from '../models/User';
import { Product } from '../models/Product';
import createHttpError from '../utils/httpError';
import { assertStoreRole } from '../utils/ownership';
import { baseSlug, disambiguateSlug } from '../utils/slug';
import { sealSecret, unsealSecret } from '../utils/crypto';
import type { AuthUser } from '../types/auth';

/**
 * Stores, their settings, and who works in them.
 *
 * Authority split, applied consistently here:
 *  - developer: products, activities, issues — the day-to-day work
 *  - manager:   the above, plus store settings and integrations
 *  - owner:     the above, plus membership and deleting the store
 *
 * A user belongs to exactly one store, so adding someone who already has one is
 * refused rather than silently moving them out of it.
 */
export class StoreService {
  /** Slug unique across stores, since it is the store's public handle. */
  private async uniqueSlug(name: string, excludeId?: string): Promise<string> {
    const base = baseSlug(name);
    const filter: Record<string, unknown> = { slug: { $regex: `^${base}(-\\d+)?$` } };
    if (excludeId) filter._id = { $ne: excludeId };
    const taken = new Set<string>(await Store.find(filter).distinct('slug'));
    return disambiguateSlug(base, taken);
  }

  /** Creates a store and makes the caller its owner. */
  async createStore(data: { name: string; description?: string }, user: AuthUser): Promise<IStore> {
    const account = await User.findById(user.id);
    if (!account) throw createHttpError(404, 'Account not found');
    if (account.storeId) {
      throw createHttpError(409, 'You already belong to a store. Leave it before creating another.');
    }

    const name = data.name.trim();
    if (!name) throw createHttpError(400, 'A store name is required.');

    const store = await Store.create({
      name,
      slug: await this.uniqueSlug(name),
      ownerId: account._id,
      description: data.description?.trim() || '',
    });

    account.storeId = store._id as never;
    account.storeRole = 'owner';
    await account.save();

    return store;
  }

  /** The caller's store, or null while they have none. */
  async getMyStore(user: AuthUser): Promise<IStore | null> {
    if (!user.storeId) return null;
    return Store.findById(user.storeId);
  }

  /** Every store. Platform admins only — this is the support view. */
  async listAllStores(user: AuthUser) {
    if (user.role !== 'admin') throw createHttpError(403, 'Administrators only.');
    const stores = await Store.find().sort({ createdAt: -1, _id: -1 }).lean();
    const counts = await Promise.all(
      stores.map(async (s) => ({
        members: await User.countDocuments({ storeId: s._id }),
        products: await Product.countDocuments({ storeId: s._id }),
      })),
    );
    return stores.map((s, i) => ({ ...s, ...counts[i] }));
  }

  /** Profile and settings. Requires manager; the Ollama key is write-only. */
  async updateStore(data: Record<string, any>, user: AuthUser): Promise<IStore> {
    assertStoreRole(user, 'manager');
    const store = await Store.findById(user.storeId).select('+intelligence.ollamaCloudKey');
    if (!store) throw createHttpError(404, 'Store not found');

    if (typeof data.name === 'string' && data.name.trim()) {
      store.name = data.name.trim();
      store.slug = await this.uniqueSlug(store.name, String(store._id));
    }
    if (typeof data.description === 'string') store.description = data.description.trim();
    if (typeof data.logoUrl === 'string') store.logoUrl = data.logoUrl.trim();

    if (data.branding) {
      const b = data.branding;
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
      store.branding = {
        companyName: str(b.companyName, 80) ?? store.branding.companyName,
        logoUrl: str(b.logoUrl, 500) ?? store.branding.logoUrl,
        accentColor: str(b.accentColor, 7) ?? store.branding.accentColor,
        accentDynamic: typeof b.accentDynamic === 'boolean' ? b.accentDynamic : store.branding.accentDynamic,
        thankYouEnabled: typeof b.thankYouEnabled === 'boolean' ? b.thankYouEnabled : store.branding.thankYouEnabled,
        thankYouTitle: str(b.thankYouTitle, 80) ?? store.branding.thankYouTitle,
        thankYouMessage: str(b.thankYouMessage, 300) ?? store.branding.thankYouMessage,
      };
    }

    if (data.intelligence) {
      const i = data.intelligence;
      if (typeof i.model === 'string' && i.model.trim()) store.intelligence.model = i.model.trim();
      if (i.ollamaMode === 'local' || i.ollamaMode === 'cloud') store.intelligence.ollamaMode = i.ollamaMode;
      if (typeof i.ollamaCloudUrl === 'string') store.intelligence.ollamaCloudUrl = i.ollamaCloudUrl.trim();
      if (typeof i.staleAlertDays === 'number' && i.staleAlertDays >= 1) {
        store.intelligence.staleAlertDays = Math.min(Math.floor(i.staleAlertDays), 365);
      }
      // Write-only: an empty value keeps the stored key, so saving any other
      // setting cannot wipe the credential. 'null' clears it deliberately.
      if (typeof i.ollamaCloudKey === 'string') {
        const incoming = i.ollamaCloudKey.trim();
        if (incoming === 'null') store.intelligence.ollamaCloudKey = '';
        else if (incoming) store.intelligence.ollamaCloudKey = sealSecret(incoming);
      }
    }

    await store.save();
    return store;
  }

  /** Everyone in the caller's store. Visible to any member. */
  async listMembers(user: AuthUser) {
    if (!user.storeId) throw createHttpError(403, 'You are not a member of a store.');
    return User.find({ storeId: user.storeId })
      .select('name email jobTitle storeRole status createdAt')
      .sort({ storeRole: 1, name: 1, _id: 1 })
      .lean();
  }

  /**
   * Adds an existing account to the store. Owner only.
   *
   * The person must already have signed up and must not belong to a store —
   * pulling someone out of their own store by adding them here would be a
   * silent, surprising side effect.
   */
  async addMember(email: string, role: StoreRole, user: AuthUser) {
    assertStoreRole(user, 'owner');
    if (role === 'owner') {
      throw createHttpError(400, 'A store has one owner. Transfer ownership instead.');
    }

    const account = await User.findOne({ email: email.trim().toLowerCase() });
    if (!account) throw createHttpError(404, 'No account with that email. Ask them to sign up first.');
    if (account.storeId) {
      throw createHttpError(
        409,
        String(account.storeId) === String(user.storeId)
          ? 'They are already in this store.'
          : 'That person already belongs to another store.',
      );
    }

    account.storeId = new mongoose.Types.ObjectId(user.storeId) as never;
    account.storeRole = role;
    await account.save();
    return { id: String(account._id), name: account.name, email: account.email, storeRole: role };
  }

  /** Changes a member's role. Owner only; the owner's own role is not editable here. */
  async setMemberRole(memberId: string, role: StoreRole, user: AuthUser) {
    assertStoreRole(user, 'owner');
    if (role === 'owner') throw createHttpError(400, 'Use transfer ownership to change the owner.');

    const account = await User.findById(memberId);
    if (!account || String(account.storeId) !== String(user.storeId)) {
      throw createHttpError(404, 'Not found');
    }
    if (account.storeRole === 'owner') throw createHttpError(400, 'Transfer ownership first.');

    account.storeRole = role;
    await account.save();
    return { id: String(account._id), storeRole: role };
  }

  /**
   * Removes someone from the store. Owner only.
   *
   * Their account survives — only the membership goes, leaving them free to
   * create or join another store. Everything they made stays with the store,
   * because it was never theirs to take.
   */
  async removeMember(memberId: string, user: AuthUser) {
    assertStoreRole(user, 'owner');
    const account = await User.findById(memberId);
    if (!account || String(account.storeId) !== String(user.storeId)) {
      throw createHttpError(404, 'Not found');
    }
    if (account.storeRole === 'owner') {
      throw createHttpError(400, 'The owner cannot be removed. Transfer ownership first.');
    }

    account.storeId = null;
    account.storeRole = undefined;
    await account.save();
    return { id: memberId };
  }

  /**
   * Moves a product to another store. Platform admins only.
   *
   * Since a user belongs to exactly one store, nobody but an operator can see
   * both sides of such a move, and doing it from inside one store would mean
   * writing into a store the caller cannot read.
   */
  async moveProduct(productId: string, toStoreId: string, user: AuthUser) {
    if (user.role !== 'admin') throw createHttpError(403, 'Administrators only.');

    const [product, target] = await Promise.all([
      Product.findById(productId),
      Store.findById(toStoreId),
    ]);
    if (!product) throw createHttpError(404, 'Product not found');
    if (!target) throw createHttpError(404, 'Target store not found');
    if (String(product.storeId) === String(target._id)) {
      throw createHttpError(400, 'The product is already in that store.');
    }

    const from = String(product.storeId);
    product.storeId = target._id as never;
    await product.save();

    // Everything hanging off the product moves with it, or it would be stranded
    // in a store that can no longer see the product it describes.
    const moved = await this.moveProductChildren(productId, target._id as never);
    return { productId, from, to: String(target._id), moved };
  }

  /** Re-points every store-scoped child of one product. */
  private async moveProductChildren(productId: string, storeId: mongoose.Types.ObjectId) {
    const { Activity } = await import('../models/Activity');
    const { Version } = await import('../models/Version');
    const { ProductMarketing } = await import('../models/ProductMarketing');
    const { Issue } = await import('../models/Issue');
    const { UninstallFeedback } = await import('../models/UninstallFeedback');

    const filter = { productId };
    const update = { $set: { storeId } };
    const [activities, versions, marketing, issues, uninstalls] = await Promise.all([
      Activity.updateMany(filter, update),
      Version.updateMany(filter, update),
      ProductMarketing.updateMany(filter, update),
      Issue.updateMany(filter, update),
      UninstallFeedback.updateMany(filter, update),
    ]);
    return {
      activities: activities.modifiedCount,
      versions: versions.modifiedCount,
      marketing: marketing.modifiedCount,
      issues: issues.modifiedCount,
      uninstalls: uninstalls.modifiedCount,
    };
  }

  /** The store's Ollama key in plaintext, for server-side use only. */
  static async ollamaCredentials(storeId: string | mongoose.Types.ObjectId) {
    const store = await Store.findById(storeId).select('+intelligence.ollamaCloudKey');
    if (!store) return null;
    return {
      model: store.intelligence.model,
      mode: store.intelligence.ollamaMode,
      url: store.intelligence.ollamaCloudUrl,
      key: unsealSecret(store.intelligence.ollamaCloudKey || ''),
    };
  }
}

export const canManageSettings = (user: AuthUser) => roleAtLeast(user.storeRole, 'manager') || user.role === 'admin';
