import { db } from '../config/database';
import { kioskLogs, locations, users } from '../db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.util';

export type LocationName = 'Pimlico' | 'Kensington';

export interface KioskLocation {
  id: string;
  name: LocationName;
  roomCount: number;
}

export interface KioskPractitioner {
  id: string;
  firstName: string;
  lastName: string;
  photoUrl?: string;
  isSignedIn: boolean;
  signedInAt: Date | null;
  isDummy: boolean;
}

export interface PractitionerPresence {
  userId: string;
  firstName: string;
  lastName: string;
  photoUrl?: string;
  signedInAt: Date | null;
  isDummy: boolean;
}

export interface AdminKioskRow {
  userId: string;
  firstName: string;
  lastName: string;
  photoUrl?: string;
  lastCheckInAt: Date | null;
  kensingtonStatus: 'in' | 'out';
  pimlicoStatus: 'in' | 'out';
  isDummy: boolean;
}

const DUMMY_KENSINGTON_USER_ID = process.env.DUMMY_KENSINGTON_USER_ID || '';

function isValidLocationName(name: string): name is LocationName {
  return name === 'Pimlico' || name === 'Kensington';
}

async function getLocationByName(name: LocationName) {
  const [row] = await db
    .select({
      id: locations.id,
      name: locations.name,
      roomCount: locations.roomCount,
    })
    .from(locations)
    .where(eq(locations.name, name))
    .limit(1);

  if (!row) {
    throw new Error(`Location not found: ${name}`);
  }

  return {
    id: row.id,
    name: row.name as LocationName,
    roomCount: Number(row.roomCount),
  };
}

async function getLatestKioskActionsForLocation(locationId: string) {
  // Get latest kiosk action per user for this location.
  // We cap to a reasonable number of rows for performance.
  const rows = await db
    .select({
      userId: kioskLogs.userId,
      action: kioskLogs.action,
      actionTime: kioskLogs.actionTime,
    })
    .from(kioskLogs)
    .where(eq(kioskLogs.locationId, locationId))
    .orderBy(desc(kioskLogs.actionTime))
    .limit(5000);

  const latestByUser = new Map<
    string,
    { action: 'sign_in' | 'sign_out'; actionTime: Date }
  >();

  for (const row of rows) {
    if (!latestByUser.has(row.userId)) {
      latestByUser.set(row.userId, {
        action: row.action,
        actionTime: row.actionTime,
      });
    }
  }

  return latestByUser;
}

export class KioskService {
  static async getLocations(): Promise<KioskLocation[]> {
    const rows = await db
      .select({
        id: locations.id,
        name: locations.name,
        roomCount: locations.roomCount,
      })
      .from(locations)
      .where(
        inArray(locations.name, ['Pimlico', 'Kensington'] as LocationName[])
      )
      .orderBy(locations.name);

    return rows.map((r) => ({
      id: r.id,
      name: r.name as LocationName,
      roomCount: Number(r.roomCount),
    }));
  }

  static normalizeLocationParam(param: string): LocationName {
    const normalized = param.trim().toLowerCase();
    const mapped =
      normalized === 'pimlico'
        ? 'Pimlico'
        : normalized === 'kensington' || normalized === 'gloucester'
        ? 'Kensington'
        : null;

    if (!mapped || !isValidLocationName(mapped)) {
      throw new Error(
        'Invalid location. Allowed values: pimlico, kensington'
      );
    }

    return mapped;
  }

  static async getPractitionersForLocation(
    locationName: LocationName
  ): Promise<{ location: KioskLocation; practitioners: KioskPractitioner[] }> {
    const location = await getLocationByName(locationName);

    // Get all active practitioners
    const practitioners = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        photoUrl: users.photoUrl,
      })
      .from(users)
      .where(
        and(
          eq(users.role, 'practitioner'),
          eq(users.status, 'active'),
          sql`${users.deletedAt} IS NULL`
        )
      )
      .orderBy(sql`LOWER(${users.firstName})`, sql`LOWER(${users.lastName})`);

    const latestByUser = await getLatestKioskActionsForLocation(location.id);

    const result: KioskPractitioner[] = practitioners.map((p) => {
      const latest = latestByUser.get(p.id);
      const isDummy = Boolean(
        locationName === 'Kensington' &&
          DUMMY_KENSINGTON_USER_ID &&
          p.id === DUMMY_KENSINGTON_USER_ID
      );

      const isSignedIn =
        (latest?.action === 'sign_in') || (isDummy && !latest);

      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        photoUrl: p.photoUrl || undefined,
        isSignedIn: Boolean(isSignedIn),
        signedInAt: latest?.actionTime ?? null,
        isDummy,
      };
    });

    return { location, practitioners: result };
  }

  static async signIn(
    userId: string,
    locationName: LocationName,
    ipAddress?: string | null
  ): Promise<void> {
    const location = await getLocationByName(locationName);

    // Validate practitioner exists and is active
    const [userRow] = await db
      .select({
        id: users.id,
        role: users.role,
        status: users.status,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (
      !userRow ||
      userRow.role !== 'practitioner' ||
      userRow.status !== 'active' ||
      userRow.deletedAt !== null
    ) {
      throw new Error('Practitioner not found or not active');
    }

    await db.insert(kioskLogs).values({
      userId,
      locationId: location.id,
      action: 'sign_in',
      ipAddress: ipAddress || null,
    });
  }

  static async signOut(
    userId: string,
    locationName: LocationName,
    ipAddress?: string | null
  ): Promise<void> {
    // Prevent signing out the dummy Kensington user from kiosk endpoints
    if (
      locationName === 'Kensington' &&
      DUMMY_KENSINGTON_USER_ID &&
      userId === DUMMY_KENSINGTON_USER_ID
    ) {
      logger.info('Ignoring sign-out for dummy Kensington kiosk user', {
        userId,
        locationName,
      });
      return;
    }

    const location = await getLocationByName(locationName);

    await db.insert(kioskLogs).values({
      userId,
      locationId: location.id,
      action: 'sign_out',
      ipAddress: ipAddress || null,
    });
  }

  static async getPresenceByLocation(
    locationName: LocationName
  ): Promise<PractitionerPresence[]> {
    const { practitioners } =
      await this.getPractitionersForLocation(locationName);

    return practitioners
      .filter((p) => p.isSignedIn)
      .map((p) => ({
        userId: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        photoUrl: p.photoUrl,
        signedInAt: p.signedInAt,
        isDummy: p.isDummy,
      }));
  }

  /**
   * Admin overview: one row per practitioner with combined Pimlico/Kensington status.
   */
  static async getAdminOverview(): Promise<AdminKioskRow[]> {
    const locations = await this.getLocations();
    const pimlico = locations.find((l) => l.name === 'Pimlico');
    const kensington = locations.find((l) => l.name === 'Kensington');

    if (!pimlico || !kensington) {
      throw new Error('Pimlico and Kensington locations must exist');
    }

    const [pimlicoLatest, kensingtonLatest] = await Promise.all([
      getLatestKioskActionsForLocation(pimlico.id),
      getLatestKioskActionsForLocation(kensington.id),
    ]);

    const practitioners = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        photoUrl: users.photoUrl,
      })
      .from(users)
      .where(
        and(
          eq(users.role, 'practitioner'),
          eq(users.status, 'active'),
          sql`${users.deletedAt} IS NULL`
        )
      )
      .orderBy(sql`LOWER(${users.firstName})`, sql`LOWER(${users.lastName})`);

    return practitioners.map((p) => {
      const pimlicoEntry = pimlicoLatest.get(p.id);
      const kensingtonEntry = kensingtonLatest.get(p.id);
      const isDummy = Boolean(
        DUMMY_KENSINGTON_USER_ID && p.id === DUMMY_KENSINGTON_USER_ID
      );

      const pimlicoStatus: 'in' | 'out' =
        pimlicoEntry?.action === 'sign_in' ? 'in' : 'out';

      // Dummy Kensington user is always effectively "in"
      const kensingtonStatus: 'in' | 'out' =
        kensingtonEntry?.action === 'sign_in'
          ? 'in'
          : isDummy && !kensingtonEntry
            ? 'in'
            : 'out';

      const lastCheckInTimes: Date[] = [];
      if (pimlicoEntry?.action === 'sign_in') lastCheckInTimes.push(pimlicoEntry.actionTime);
      if (kensingtonEntry?.action === 'sign_in') lastCheckInTimes.push(kensingtonEntry.actionTime);

      const lastCheckInAt =
        lastCheckInTimes.length > 0
          ? lastCheckInTimes.reduce((latest, current) =>
              current > latest ? current : latest
            )
          : null;

      return {
        userId: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        photoUrl: p.photoUrl || undefined,
        lastCheckInAt,
        kensingtonStatus,
        pimlicoStatus,
        isDummy: Boolean(isDummy),
      };
    });
  }

  /**
   * Get current kiosk status for a single practitioner across all locations.
   */
  static async getUserStatus(userId: string): Promise<{
    isSignedIn: boolean;
    location: LocationName | null;
    signedInAt: Date | null;
  }> {
    // Find the most recent kiosk log for this user across all locations
    const [row] = await db
      .select({
        action: kioskLogs.action,
        actionTime: kioskLogs.actionTime,
        locationName: locations.name,
      })
      .from(kioskLogs)
      .innerJoin(locations, eq(kioskLogs.locationId, locations.id))
      .where(eq(kioskLogs.userId, userId))
      .orderBy(desc(kioskLogs.actionTime))
      .limit(1);

    if (!row) {
      return { isSignedIn: false, location: null, signedInAt: null };
    }

    const location =
      row.locationName === 'Pimlico' || row.locationName === 'Kensington'
        ? (row.locationName as LocationName)
        : null;

    const isSignedIn = row.action === 'sign_in';

    return {
      isSignedIn,
      location: isSignedIn ? location : null,
      signedInAt: isSignedIn ? row.actionTime : null,
    };
  }

  /**
   * Sign the user out from whichever location they are currently signed into.
   * If they are not currently signed in, this is a no-op.
   */
  static async signOutCurrentForUser(
    userId: string,
    ipAddress?: string | null
  ): Promise<{
    isSignedIn: boolean;
    location: LocationName | null;
    signedInAt: Date | null;
  }> {
    const status = await this.getUserStatus(userId);

    if (!status.isSignedIn || !status.location) {
      return status;
    }

    await this.signOut(userId, status.location, ipAddress);

    return await this.getUserStatus(userId);
  }
}

