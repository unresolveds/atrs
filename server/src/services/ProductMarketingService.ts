import { ProductMarketingRepository } from '../repositories/ProductMarketingRepository';
import { IProductMarketing } from '../models/ProductMarketing';
import { Product } from '../models/Product';
import { deleteMediaFiles } from '../utils/fileUtils';
import { AuditLogService } from './AuditLogService';
import { assertStoreAccess } from '../utils/ownership';
import createHttpError from '../utils/httpError';
import type { AuthUser } from '../types/auth';

const auditLogService = new AuditLogService();

export class ProductMarketingService {
  private repository: ProductMarketingRepository;

  constructor() {
    this.repository = new ProductMarketingRepository();
  }

  /** Loads the product and verifies the user owns it (404 otherwise). */
  private async assertProductOwned(productId: string, user: AuthUser) {
    if (!productId) throw createHttpError(400, 'Product ID is required');
    const product = await Product.findById(productId);
    assertStoreAccess(product, user);
    return product!;
  }

  async getMarketingData(productId: string, user: AuthUser): Promise<IProductMarketing | null> {
    await this.assertProductOwned(productId, user);
    return await this.repository.findByProductId(productId);
  }

  async upsertMarketingData(productId: string, data: Partial<IProductMarketing>, user: AuthUser): Promise<IProductMarketing> {
    const product = await this.assertProductOwned(productId, user);
    const clean: any = { ...data };
    delete clean.storeId;
    delete clean.productId;
    const result = await this.repository.upsertByProductId(productId, { ...clean, storeId: product.storeId });
    await auditLogService.logEvent('UPDATE', 'MARKETING', productId, product.name, 'Updated marketing hub', { id: user.id, name: user.name });
    return result;
  }

  async deleteMarketingData(productId: string, user: AuthUser): Promise<boolean> {
    const product = await this.assertProductOwned(productId, user);
    const data = await this.repository.findByProductId(productId);
    if (data) {
      const mediaUrls: (string | undefined)[] = [
        data.trailerVideo,
        data.tutorialVideo,
        data.thumbnailImage,
      ];
      data.keyFeatures?.forEach((kf: any) => mediaUrls.push(kf.mediaUrl));
      data.screenshots?.forEach((ss: any) => mediaUrls.push(ss.url));
      data.demos?.forEach((demo: any) => mediaUrls.push(demo.icon));

      deleteMediaFiles(mediaUrls.filter(Boolean) as string[]);
    }
    const deleted = await this.repository.deleteByProductId(productId);
    if (deleted) {
      await auditLogService.logEvent('DELETE', 'MARKETING', productId, product.name, 'Deleted marketing hub', { id: user.id, name: user.name });
    }
    return deleted;
  }
}
