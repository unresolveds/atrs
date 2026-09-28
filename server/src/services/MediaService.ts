import fs from 'fs';
import { storeFilter } from '../utils/ownership';
import path from 'path';
import { Product } from '../models/Product';
import { ProductMarketing } from '../models/ProductMarketing';
import { Activity } from '../models/Activity';
import createHttpError from '../utils/httpError';
import type { AuthUser } from '../types/auth';
import {
  isR2Active,
  listR2Objects,
  deleteFromR2,
  r2ObjectExists,
  r2PublicUrl,
} from '../utils/r2Storage';

export interface IMediaReference {
  entityType: 'product' | 'marketing' | 'activity';
  entityId: string;
  entityName: string;
  field: string;
  productId?: string;
  productName?: string;
}

export interface IMediaFile {
  filename: string;
  url: string;
  size: number;
  mimeType: string;
  createdAt: Date;
  references: IMediaReference[];
  isOrphaned: boolean;
  /** Where the file physically lives. */
  storage: 'local' | 'r2';
}

interface IMediaEntities {
  products: any[];
  marketings: any[];
  activities: any[];
}

export class MediaService {
  private uploadsDir = path.join(__dirname, '../../../uploads');

  constructor() {
    // Skip on read-only serverless filesystems (Vercel) — media lives in R2.
    try {
      if (!fs.existsSync(this.uploadsDir)) {
        fs.mkdirSync(this.uploadsDir, { recursive: true });
      }
    } catch {
      /* read-only filesystem — local media features are inert */
    }
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.svg':
        return 'image/svg+xml';
      case '.webp':
        return 'image/webp';
      case '.mp4':
        return 'video/mp4';
      case '.webm':
        return 'video/webm';
      case '.ogg':
        return 'video/ogg';
      default:
        return 'application/octet-stream';
    }
  }

  /** Resolves a filename inside the uploads dir, rejecting any path traversal. */
  private safeResolve(filename: string): string {
    const resolved = path.resolve(this.uploadsDir, filename);
    const root = path.resolve(this.uploadsDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw createHttpError(400, 'Invalid filename');
    }
    return resolved;
  }

  /** Loads every entity that can reference media, scoped to the user's store unless admin. */
  private async loadMediaEntities(user?: AuthUser): Promise<IMediaEntities> {
    // storeFilter already exempts admins and matches nothing for a user with no
    // store — important here, because an unscoped filter would sweep every
    // store's media into one orphan report.
    const storeScope = storeFilter(user);

    const [products, marketings, activities] = await Promise.all([
      Product.find(storeScope, 'name slug banner icon').lean(),
      ProductMarketing.find(storeScope, 'productId pluginName thumbnailImage trailerVideo tutorialVideo keyFeatures screenshots')
        .populate('productId', 'name slug')
        .lean(),
      Activity.find(storeScope, 'productId type title mediaUrl mediaUrls items')
        .populate('productId', 'name slug')
        .lean()
    ]);

    return { products, marketings, activities };
  }

  /** Finds every entity field whose stored URL exactly matches `fileUrl`. */
  private collectReferences(fileUrl: string, entities: IMediaEntities): IMediaReference[] {
    const { products, marketings, activities } = entities;
    const references: IMediaReference[] = [];

    // Check Products
    for (const prod of products) {
      const pId = (prod as any)._id.toString();
      const pName = prod.name;
      if (prod.banner === fileUrl) {
        references.push({
          entityType: 'product',
          entityId: pId,
          entityName: pName,
          field: 'banner',
          productId: pId,
          productName: pName
        });
      }
      if (prod.icon === fileUrl) {
        references.push({
          entityType: 'product',
          entityId: pId,
          entityName: pName,
          field: 'icon',
          productId: pId,
          productName: pName
        });
      }
    }

    // Check Product Marketing
    for (const mkt of marketings) {
      const prodName = (mkt.productId as any)?.name || mkt.pluginName || 'Unknown Product';
      const pId = (mkt.productId as any)?._id?.toString() || mkt.productId?.toString();
      if (mkt.thumbnailImage === fileUrl) {
        references.push({
          entityType: 'marketing',
          entityId: (mkt as any)._id.toString(),
          entityName: prodName,
          field: 'thumbnailImage',
          productId: pId,
          productName: prodName
        });
      }
      if (mkt.trailerVideo === fileUrl) {
        references.push({
          entityType: 'marketing',
          entityId: (mkt as any)._id.toString(),
          entityName: prodName,
          field: 'trailerVideo',
          productId: pId,
          productName: prodName
        });
      }
      if (mkt.tutorialVideo === fileUrl) {
        references.push({
          entityType: 'marketing',
          entityId: (mkt as any)._id.toString(),
          entityName: prodName,
          field: 'tutorialVideo',
          productId: pId,
          productName: prodName
        });
      }
      if (mkt.keyFeatures && Array.isArray(mkt.keyFeatures)) {
        mkt.keyFeatures.forEach((kf: any, idx: number) => {
          if (kf.mediaUrl === fileUrl) {
            references.push({
              entityType: 'marketing',
              entityId: (mkt as any)._id.toString(),
              entityName: prodName,
              field: `keyFeatures[${idx}].mediaUrl`,
              productId: pId,
              productName: prodName
            });
          }
        });
      }
      if (mkt.screenshots && Array.isArray(mkt.screenshots)) {
        mkt.screenshots.forEach((scr: any, idx: number) => {
          if (scr.url === fileUrl) {
            references.push({
              entityType: 'marketing',
              entityId: (mkt as any)._id.toString(),
              entityName: prodName,
              field: `screenshots[${idx}].url`,
              productId: pId,
              productName: prodName
            });
          }
        });
      }
    }

    // Check Activities
    for (const act of activities) {
      const prodName = (act.productId as any)?.name || 'Unknown Product';
      const pId = (act.productId as any)?._id?.toString() || act.productId?.toString();
      if (act.mediaUrl === fileUrl) {
        references.push({
          entityType: 'activity',
          entityId: (act as any)._id.toString(),
          entityName: `${act.title} (${prodName})`,
          field: 'mediaUrl',
          productId: pId,
          productName: prodName
        });
      }
      if (act.mediaUrls && Array.isArray(act.mediaUrls)) {
        act.mediaUrls.forEach((url: string, idx: number) => {
          if (url === fileUrl) {
            references.push({
              entityType: 'activity',
              entityId: (act as any)._id.toString(),
              entityName: `${act.title} (${prodName})`,
              field: `mediaUrls[${idx}]`,
              productId: pId,
              productName: prodName
            });
          }
        });
      }
      if (act.items && Array.isArray(act.items)) {
        act.items.forEach((item: any, itemIdx: number) => {
          if (item.mediaUrl === fileUrl) {
            references.push({
              entityType: 'activity',
              entityId: (act as any)._id.toString(),
              entityName: `${act.title} -> ${item.title} (${prodName})`,
              field: `items[${itemIdx}].mediaUrl`,
              productId: pId,
              productName: prodName
            });
          }
          if (item.mediaUrls && Array.isArray(item.mediaUrls)) {
            item.mediaUrls.forEach((url: string, urlIdx: number) => {
              if (url === fileUrl) {
                references.push({
                  entityType: 'activity',
                  entityId: (act as any)._id.toString(),
                  entityName: `${act.title} -> ${item.title} (${prodName})`,
                  field: `items[${itemIdx}].mediaUrls[${urlIdx}]`,
                  productId: pId,
                  productName: prodName
                });
              }
            });
          }
        });
      }
    }

    return references;
  }

  public async getAllMedia(user?: AuthUser): Promise<IMediaFile[]> {
    const isAdmin = user?.role === 'admin';
    const entities = await this.loadMediaEntities(user);
    const mediaFiles: IMediaFile[] = [];

    // Local uploads directory
    if (fs.existsSync(this.uploadsDir)) {
      const files = fs.readdirSync(this.uploadsDir);
      for (const file of files) {
        // Skip hidden/system files
        if (file.startsWith('.')) continue;

        const filePath = path.join(this.uploadsDir, file);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
          if (!stats.isFile()) continue;
        } catch (err) {
          continue;
        }

        const fileUrl = `/uploads/${file}`;
        const references = this.collectReferences(fileUrl, entities);

        // Non-admins must not see files that none of their own content references.
        if (!isAdmin && references.length === 0) continue;

        mediaFiles.push({
          filename: file,
          url: fileUrl,
          size: stats.size,
          mimeType: this.getMimeType(file),
          createdAt: stats.mtime,
          references,
          isOrphaned: references.length === 0,
          storage: 'local'
        });
      }
    }

    // Cloudflare R2 bucket (when configured). A listing failure shouldn't
    // take down the whole media library — degrade to local-only.
    if (isR2Active()) {
      try {
        const objects = await listR2Objects();
        for (const obj of objects) {
          const fileUrl = r2PublicUrl(obj.key);
          const references = this.collectReferences(fileUrl, entities);
          if (!isAdmin && references.length === 0) continue;

          mediaFiles.push({
            filename: obj.key,
            url: fileUrl,
            size: obj.size,
            mimeType: this.getMimeType(obj.key),
            createdAt: obj.lastModified,
            references,
            isOrphaned: references.length === 0,
            storage: 'r2'
          });
        }
      } catch (err) {
        console.error('Failed to list Cloudflare R2 objects:', err);
      }
    }

    // Sort by modified/creation time descending
    return mediaFiles.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private async assertUnreferenced(fileUrl: string, filename: string): Promise<void> {
    const [prodCount, mktCount, actCount] = await Promise.all([
      Product.countDocuments({ $or: [{ banner: fileUrl }, { icon: fileUrl }] }),
      ProductMarketing.countDocuments({
        $or: [
          { thumbnailImage: fileUrl },
          { trailerVideo: fileUrl },
          { tutorialVideo: fileUrl },
          { 'keyFeatures.mediaUrl': fileUrl },
          { 'screenshots.url': fileUrl }
        ]
      }),
      Activity.countDocuments({
        $or: [
          { mediaUrl: fileUrl },
          { mediaUrls: fileUrl },
          { 'items.mediaUrl': fileUrl },
          { 'items.mediaUrls': fileUrl }
        ]
      })
    ]);

    if (prodCount > 0 || mktCount > 0 || actCount > 0) {
      throw new Error(`Cannot delete referenced file: ${filename}. It is in use.`);
    }
  }

  public async deleteMedia(filename: string, force: boolean = false): Promise<{ success: boolean; filename: string }> {
    // Local file takes precedence; fall back to the R2 bucket.
    const filePath = this.safeResolve(filename);
    if (fs.existsSync(filePath)) {
      if (!force) {
        await this.assertUnreferenced(`/uploads/${filename}`, filename);
      }
      fs.unlinkSync(filePath);
      return { success: true, filename };
    }

    if (isR2Active() && (await r2ObjectExists(filename))) {
      if (!force) {
        await this.assertUnreferenced(r2PublicUrl(filename), filename);
      }
      await deleteFromR2(filename);
      return { success: true, filename };
    }

    throw new Error(`File ${filename} not found`);
  }

  public async purgeOrphaned(): Promise<string[]> {
    const allMedia = await this.getAllMedia();
    const orphanedMedia = allMedia.filter(media => media.isOrphaned);
    const deletedFiles: string[] = [];

    for (const media of orphanedMedia) {
      try {
        if (media.storage === 'r2') {
          await deleteFromR2(media.filename);
          deletedFiles.push(media.filename);
          continue;
        }
        const filePath = this.safeResolve(media.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deletedFiles.push(media.filename);
        }
      } catch (err) {
        console.error(`Failed to delete orphaned file ${media.filename}:`, err);
      }
    }

    return deletedFiles;
  }
}
