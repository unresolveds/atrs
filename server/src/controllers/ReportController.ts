import { Request, Response, NextFunction } from 'express';
import { ReportService } from '../services/ReportService';

const reportService = new ReportService();

export const getMonthlyReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { month, year, productId, startDate, endDate, storeId } = req.query;

    // Support custom date range OR month/year
    if (startDate && endDate) {
      const report = await reportService.getMonthlyReport(
        0, 0,
        req.user!,
        productId as string,
        startDate as string,
        endDate as string,
        storeId as string
      );
      return res.status(200).json(report);
    }

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year (or startDate and endDate) are required' });
    }

    const monthNum = parseInt(month as string, 10);
    const yearNum = parseInt(year as string, 10);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: 'Month must be between 1 and 12' });
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({ message: 'Year must be between 2000 and 2100' });
    }

    const report = await reportService.getMonthlyReport(
      monthNum,
      yearNum,
      req.user!,
      productId as string,
      undefined,
      undefined,
      storeId as string
    );
    res.status(200).json(report);
  } catch (error) {
    next(error);
  }
};

export const getTrend = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedMonths = parseInt(req.query.months as string, 10);
    // Clamp to a sane window so a caller can't request thousands of buckets.
    const months = Number.isInteger(parsedMonths) ? Math.min(Math.max(parsedMonths, 1), 60) : 6;
    const productId = req.query.productId as string | undefined;
    const data = await reportService.getTrendData(months, req.user!, productId);
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getAnnual = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedYear = parseInt(req.query.year as string, 10);
    const year = Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : new Date().getFullYear();
    const productId = req.query.productId as string | undefined;
    const storeId = req.query.storeId as string | undefined;
    const data = await reportService.getAnnualReport(year, req.user!, productId, storeId);
    res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
