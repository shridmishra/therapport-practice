import { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware';
import { db } from '../config/database';
import { kioskLogs, users, locations } from '../db/schema';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.util';

export class KioskAdminController {
  async getLogs(req: AuthRequest, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, error: 'Authentication required' });
      }

      const location = (req.query.location as string | undefined)?.trim();
      const userId = (req.query.userId as string | undefined)?.trim();
      const search = (req.query.search as string | undefined)?.trim();
      const from = (req.query.from as string | undefined)?.trim();
      const to = (req.query.to as string | undefined)?.trim();
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, parseInt(req.query.pageSize as string, 10) || 50)
      );
      const offset = (page - 1) * pageSize;

      let locationFilter: 'Pimlico' | 'Kensington' | null = null;
      if (location) {
        const normalized = location.toLowerCase();
        if (normalized === 'pimlico') locationFilter = 'Pimlico';
        else if (normalized === 'kensington' || normalized === 'gloucester')
          locationFilter = 'Kensington';
        else {
          return res.status(400).json({
            success: false,
            error: 'Invalid location. Allowed: Pimlico, Kensington',
          });
        }
      }

      const where = sql`true`;
      const conditions: any[] = [];

      if (locationFilter) {
        conditions.push(eq(locations.name, locationFilter));
      }

      if (userId) {
        conditions.push(eq(users.id, userId));
      }

      if (search) {
        const like = `%${search}%`;
        conditions.push(
          sql`(${ilike(users.firstName, like)} OR ${ilike(
            users.lastName,
            like
          )})`
        );
      }

      if (from) {
        conditions.push(sql`${kioskLogs.actionTime} >= ${from}`);
      }
      if (to) {
        conditions.push(sql`${kioskLogs.actionTime} <= ${to}::timestamp + interval '1 day'`);
      }

      const whereClause =
        conditions.length > 0
          ? and(where, ...conditions)
          : where;

      const [countRow] = await db
        .select({
          count: sql<number>`count(*)`,
        })
        .from(kioskLogs)
        .innerJoin(users, eq(kioskLogs.userId, users.id))
        .innerJoin(locations, eq(kioskLogs.locationId, locations.id))
        .where(whereClause);

      const total = Number(countRow?.count ?? 0);

      const rows = await db
        .select({
          id: kioskLogs.id,
          nameFirst: users.firstName,
          nameLast: users.lastName,
          locationName: locations.name,
          actionTime: kioskLogs.actionTime,
          action: kioskLogs.action,
        })
        .from(kioskLogs)
        .innerJoin(users, eq(kioskLogs.userId, users.id))
        .innerJoin(locations, eq(kioskLogs.locationId, locations.id))
        .where(whereClause)
        .orderBy(desc(kioskLogs.actionTime))
        .limit(pageSize)
        .offset(offset);

      const data = rows.map((r) => ({
        id: r.id,
        name: `${r.nameFirst} ${r.nameLast}`.trim(),
        location: r.locationName,
        time: r.actionTime,
        status: r.action === 'sign_in' ? 'In' : 'Out',
      }));

      res.status(200).json({
        success: true,
        data: {
          data,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
          },
        },
      });
    } catch (error) {
      logger.error('Failed to get kiosk logs', error, {
        userId: req.user?.id,
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const kioskAdminController = new KioskAdminController();

