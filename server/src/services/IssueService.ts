import { Issue, IIssue } from '../models/Issue';
import { Product } from '../models/Product';
import { AuditLogService } from './AuditLogService';
import { notificationManager } from './NotificationManager';
import { storeFilter, assertStoreAccess } from '../utils/ownership';
import { escapeHtml, plainTextToSafeHtml } from '../utils/html';
import createHttpError from '../utils/httpError';
import type { AuthUser } from '../types/auth';

const auditLogService = new AuditLogService();

const RESOLVED_STATUSES = ['resolved', 'closed'];

export class IssueService {
  async createIssue(data: any, user: AuthUser): Promise<IIssue> {
    const product = await Product.findById(data.productId);
    assertStoreAccess(product, user);
    // Stamp the resolution time when an issue is filed already resolved/closed.
    if (RESOLVED_STATUSES.includes(data.status) && !data.resolvedAt) {
      data.resolvedAt = new Date();
    }
    const issue = new Issue({ ...data, storeId: product!.storeId });
    await issue.save();
    await auditLogService.logEvent('CREATE', 'ISSUE', issue._id.toString(), issue.title, `Reported issue "${issue.title}"`, { id: user.id, name: user.name });
    return issue;
  }

  async getIssues(productId: string | undefined, user: AuthUser): Promise<IIssue[]> {
    // With a productId, return that product's issues. Without one, return every
    // issue the user owns and populate the product so the dashboard can group
    // and link them.
    const filter = productId ? storeFilter(user, { productId }) : storeFilter(user);
    const query = Issue.find(filter).sort({ createdAt: -1 });
    if (!productId) query.populate('productId', 'name slug icon');
    return await query;
  }

  /**
   * Publicly-reported issues awaiting the owner's approval, across all their
   * products (admins see everyone's). Powers the Review queue + nav badge.
   */
  async getPendingReview(user: AuthUser): Promise<IIssue[]> {
    return await Issue.find(storeFilter(user, { source: 'public', needsReview: true }))
      .sort({ createdAt: -1 })
      .populate('productId', 'name slug icon');
  }

  async getIssueById(id: string, user: AuthUser): Promise<IIssue | null> {
    const issue = await Issue.findById(id);
    assertStoreAccess(issue, user);
    return issue;
  }

  async updateIssue(id: string, data: any, user: AuthUser): Promise<IIssue | null> {
    const existing = await Issue.findById(id);
    assertStoreAccess(existing, user);
    delete data.storeId;
    // Keep resolvedAt in sync with the status transition.
    if (data.status) {
      const nowResolved = RESOLVED_STATUSES.includes(data.status);
      const wasResolved = RESOLVED_STATUSES.includes(existing!.status);
      if (nowResolved && !wasResolved && !data.resolvedAt) data.resolvedAt = new Date();
      if (!nowResolved && wasResolved) data.resolvedAt = null;
    }
    const issue = await Issue.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (issue) {
      await auditLogService.logEvent('UPDATE', 'ISSUE', issue._id.toString(), issue.title, `Updated issue "${issue.title}"`, { id: user.id, name: user.name });
    }
    return issue;
  }

  async deleteIssue(id: string, user: AuthUser): Promise<IIssue | null> {
    const existing = await Issue.findById(id);
    assertStoreAccess(existing, user);
    const issue = await Issue.findByIdAndDelete(id);
    if (issue) {
      await auditLogService.logEvent('DELETE', 'ISSUE', issue._id.toString(), issue.title, `Deleted issue "${issue.title}"`, { id: user.id, name: user.name });
    }
    return issue;
  }

  /**
   * Public (no auth): issues for a product whose owner opted in. Excludes
   * submissions still awaiting review so unmoderated public reports never appear
   * on the published page.
   */
  async getPublicIssues(productId: string): Promise<IIssue[]> {
    return await Issue.find({ productId, needsReview: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean() as unknown as IIssue[];
  }

  /**
   * Public (no auth): create an issue from the "Report an issue" form. The
   * product must have opted into a public issues page. Untrusted text is
   * sanitized; the issue is queued for owner review (hidden until approved).
   */
  async reportPublicIssue(
    productId: string,
    data: { title: string; description?: string; versionLabel?: string; reporter?: string; reporterEmail?: string },
  ): Promise<{ ok: true }> {
    const product = await Product.findById(productId);
    if (!product || !product.publicIssuesEnabled) {
      // Mirror getPublicIssues: don't reveal whether the id exists.
      throw createHttpError(404, 'Issues not found');
    }

    const issue = await Issue.create({
      productId,
      storeId: product.storeId,
      title: escapeHtml(data.title.trim()).slice(0, 200),
      description: data.description ? plainTextToSafeHtml(data.description.trim()) : '',
      versionLabel: data.versionLabel ? escapeHtml(data.versionLabel.trim()).slice(0, 60) : '',
      reporter: data.reporter ? escapeHtml(data.reporter.trim()).slice(0, 120) : '',
      reporterEmail: data.reporterEmail?.trim().slice(0, 200) || '',
      status: 'open',
      severity: 'medium',
      source: 'public',
      needsReview: true,
      foundAt: new Date(),
    });

    // System-actor audit entry (no AuthUser for anonymous reports).
    await auditLogService.logEvent('CREATE', 'ISSUE', issue._id.toString(), issue.title, 'Public issue report (awaiting review)');
    // Live nudge to whoever from the store is connected — a public report is
    // the store's news, not one nominated person's.
    notificationManager.sendToStore(product.storeId.toString(), 'issue-reported', {
      id: issue._id.toString(),
      productId,
      productName: product.name,
      title: issue.title,
      createdAt: issue.createdAt,
    });

    return { ok: true };
  }
}
