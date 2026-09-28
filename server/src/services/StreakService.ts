import mongoose from 'mongoose';
import { requireStoreId } from '../utils/ownership';
import { DailyLog, IDailyLog } from '../models/DailyLog';
import type { AuthUser } from '../types/auth';

export interface StreakDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  logged: boolean;
}

export interface StreakStats {
  /** Consecutive logging days ending today (or yesterday, while today is still open). */
  currentStreak: number;
  bestStreak: number;
  todayLogged: boolean;
  /** Entries logged today. */
  todayCount: number;
  totalActiveDays: number;
  /** The last 7 calendar days, oldest first (ends with today). */
  last7: StreakDay[];
  /** Today's journal entries, newest first (capped). */
  todayNotes: { _id: string; note: string; createdAt: Date }[];
}

/** `getTimezoneOffset()` minutes → an IANA-style numeric offset like "+06:00". */
function tzFromOffset(offsetMinutes: number): string {
  // JS reports minutes to ADD to local time to reach UTC (Dhaka = -360),
  // while Mongo's `timezone` wants the offset FROM UTC — so flip the sign.
  const total = -offsetMinutes;
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** YYYY-MM-DD minus n days (string math via UTC to dodge DST edges). */
function minusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** getTimezoneOffset() is within ±14h; anything else is a bogus client value. */
function clampOffset(tzOffsetMinutes: number): number {
  return Math.max(-840, Math.min(840, Math.trunc(tzOffsetMinutes) || 0));
}

/**
 * The daily-logging habit. Entries live in their own DailyLog collection —
 * a personal work journal, fully independent of the changelog/Activity schema.
 */
export class StreakService {
  /** Adds one journal entry for the caller ("what did you work on?"). */
  public async logToday(note: string, user: AuthUser): Promise<IDailyLog> {
    return DailyLog.create({ storeId: requireStoreId(user), note });
  }

  /**
   * Removes one of the caller's own journal entries. Strictly owner-only —
   * the journal is private, so even admins can't touch someone else's notes.
   * Non-owned/unknown ids both return null (404) so they can't be probed.
   */
  public async deleteLog(id: string, user: AuthUser): Promise<IDailyLog | null> {
    const log = await DailyLog.findById(id);
    if (!log || log.storeId.toString() !== user.id) return null;
    await log.deleteOne();
    return log;
  }

  /**
   * The caller's streak stats, bucketing entry timestamps into calendar days
   * in the CALLER's timezone. Always scoped to the user's own journal —
   * an admin's streak is their habit, not the team's.
   */
  public async getLoggingStreak(user: AuthUser, tzOffsetMinutes: number): Promise<StreakStats> {
    const offset = clampOffset(tzOffsetMinutes);
    const tz = tzFromOffset(offset);
    const storeId = new mongoose.Types.ObjectId(user.id);

    const rows: { _id: string; count: number }[] = await DailyLog.aggregate([
      { $match: { storeId } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    const countByDay = new Map(rows.map((r) => [r._id, r.count]));
    // "Today" in the caller's timezone, via the same offset arithmetic.
    const todayStart = new Date(Date.now() - offset * 60000);
    const today = todayStart.toISOString().slice(0, 10);

    // Current streak: walk back day by day. An unlogged today doesn't break
    // the chain yet — the user still has until midnight to keep it alive.
    const todayLogged = countByDay.has(today);
    let currentStreak = 0;
    let cursor = todayLogged ? today : minusDays(today, 1);
    while (countByDay.has(cursor)) {
      currentStreak++;
      cursor = minusDays(cursor, 1);
    }

    // Best streak: scan the (desc-sorted) distinct days for the longest run.
    let bestStreak = 0;
    let run = 0;
    let prev: string | null = null;
    for (const { _id: day } of rows) {
      run = prev !== null && minusDays(prev, 1) === day ? run + 1 : 1;
      bestStreak = Math.max(bestStreak, run);
      prev = day;
    }
    bestStreak = Math.max(bestStreak, currentStreak);

    const last7: StreakDay[] = Array.from({ length: 7 }, (_, i) => {
      const date = minusDays(today, 6 - i);
      return { date, logged: countByDay.has(date) };
    });

    // Today's entries (shown on the card). Midnight in the caller's timezone,
    // expressed as a UTC instant: today's date string + the flipped offset.
    const startOfTodayUtc = new Date(new Date(`${today}T00:00:00Z`).getTime() + offset * 60000);
    const todayNotes = await DailyLog.find({ storeId, createdAt: { $gte: startOfTodayUtc } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('note createdAt')
      .lean();

    return {
      currentStreak,
      bestStreak,
      todayLogged,
      todayCount: countByDay.get(today) || 0,
      totalActiveDays: rows.length,
      last7,
      todayNotes: todayNotes.map((n: any) => ({ _id: String(n._id), note: n.note, createdAt: n.createdAt })),
    };
  }
}
