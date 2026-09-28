import { Request, Response, NextFunction } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Product } from '../models/Product';
import { runStreamJob } from '../utils/sseStream';
import { runPipeline, type RangeType } from '../services/ChangelogGenService';
import { getOllamaUrl, getOllamaHeaders } from '../utils/ollama';
import { assertStoreAccess } from '../utils/ownership';
import { assertRepoPathAllowed, assertIsGitRepo } from '../utils/repoAccess';

/**
 * POST /api/changelog-gen/generate
 *
 * Runs the 4-stage changelog generation pipeline as an SSE stream.
 * Progress events are pushed to the client in real time; the final
 * `complete` event carries the generated reports.
 */
export const generate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, rangeType, from, to, model, createReviewEntries } = req.body;

    // Look up the product, confirm the caller owns it, and ensure it has a
    // repoPath inside the allowed root before running git against it.
    const found = await Product.findById(productId).select('name repoPath storeId').lean();
    assertStoreAccess(found, req.user);
    // assertStoreAccess throws on null but isn't an assertion signature, so the
    // narrowing is made explicit here rather than repeating `!` at every use —
    // and so the closure below captures a value the compiler knows is present.
    const product = found!;
    if (!product.repoPath) {
      return res.status(400).json({ message: 'This product has no repository path configured. Set one in the product settings.' });
    }
    const repoPath = product.repoPath;
    assertRepoPathAllowed(repoPath);
    assertIsGitRepo(repoPath);

    // Stream the pipeline as SSE.
    await runStreamJob(req, res, async (ctx) => {
      const result = await runPipeline(
        {
          repoPath,
          rangeType: rangeType as RangeType,
          from,
          to,
          model,
          createReviewEntries,
          productId: String(product._id),
          storeId: String(product.storeId),
        },
        ctx,
      );
      return result;
    });
  } catch (error) {
    // If SSE headers are already sent we can't use the JSON error handler.
    if (res.headersSent) {
      console.error('[ChangelogGen] post-stream error:', error);
      return;
    }
    next(error);
  }
};

/**
 * GET /api/changelog-gen/tags/:productId
 *
 * Returns the git tags for a product's repo so the UI can offer them in a
 * dropdown for the "between tags" range type.
 */
export const getTags = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await Product.findById(req.params.productId).select('repoPath storeId').lean();
    assertStoreAccess(product, req.user);
    if (!product!.repoPath) return res.status(400).json({ message: 'No repository path' });
    assertRepoPathAllowed(product!.repoPath);

    const execFileP = promisify(execFile);

    try {
      const { stdout } = await execFileP('git', ['tag', '--sort=-creatordate'], {
        cwd: product!.repoPath,
        timeout: 10_000,
      });
      const tags = stdout.trim().split('\n').filter(Boolean);
      res.json(tags);
    } catch {
      res.json([]); // Not a git repo or no tags
    }
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/changelog-gen/models
 *
 * Queries the active Ollama service tags endpoint to list all available
 * pulled models.
 */
export const getModels = async (_req: Request, res: Response, _next: NextFunction) => {
  try {
    const response = await fetch(`${getOllamaUrl()}/api/tags`, {
      headers: getOllamaHeaders(),
    });
    if (!response.ok) {
      return res.json([]);
    }
    const data: any = await response.json();
    const names = (data.models || []).map((m: any) => m.name);
    res.json(names);
  } catch {
    res.json([]);
  }
};
