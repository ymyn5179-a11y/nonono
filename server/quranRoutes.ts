import crypto from 'crypto';
import type express from 'express';
import {
  DEFAULT_ALLOWED_SURAH_IDS,
  QURAN_MANNERS,
  QURAN_RECITERS,
  QURAN_STORIES,
  QURAN_SURAHS,
  getQuranMannerById,
  getQuranReciterById,
  getQuranStoryById,
  getQuranSurahById,
} from '../src/data/quranCatalog';
import {
  buildMonthlySnapshotForChild,
  calculateStreakDays,
  getCurrentMonthKey,
  getTodayDayKey,
} from '../src/engine/monthlyReportEngine';
import { getInternalAgeBand } from '../src/utils/ageAdaptation';
import {
  clampQuranDailyMinutes,
  clampQuranRepeatCount,
  sanitizeQuranNote,
  sanitizeShortText,
} from '../src/utils/validation';
import type {
  ActivityTimelineEvent,
  QuranActivityEvent,
  QuranAdminConfirmations,
  QuranChildSettings,
  QuranConfirmationItemRecord,
  QuranContentVerificationRecord,
  QuranMannerProgress,
  QuranMemorizationStatus,
  QuranPhraseAssetStatus,
  QuranPhraseAudioAssetConfig,
  QuranReciterSpec,
  QuranReleaseReadinessSummary,
  QuranStoryProgress,
  QuranSurahHumanReviewEntry,
  QuranSurahProgress,
  QuranSurahReviewResult,
  QuranVerificationStatus,
} from '../src/types/nonoland';
import { recordAuditEvent } from './auditLog';
import type { AuthenticatedRequest, ServerDb, StoredChildRecord } from './dbTypes';
import {
  awardGardenMilestoneIdempotent,
  canUserAccessChild,
  ensureChildFamilyAndGarden,
  ensureFamilyCollections,
  isChildOrStudentRole,
  recordFamilyEvent,
  requireParentGate,
} from './familyHelpers';
import { isQuranSchemaReady, runWithPgDbLock } from './pgStore';
import {
  HUSARY_MURATTAL_SPEC,
  MAX_QF_SERVER_CACHE_DAYS,
  MAX_QF_SERVER_CACHE_MS,
  TESTING_AUDIO_CACHE_TTL_MS,
  fetchHusaryRecitationMetadata,
  fetchHusaryTestingAudioUrls,
  getCachedHusaryBasmalaCandidateUrl,
  isAllowedQuranFoundationAudioHost,
  isQuranFoundationConfigured,
  normalizeQuranAudioUrl,
  resolveConfiguredQuranFoundationScopes,
} from './quranAudioProvider';
import { QURAN_FOUNDATION_LICENSE_INFO } from './quranValidation';
import { getClientIp } from './security';

interface QuranRoutesDeps {
  app: express.Express;
  getDb: () => ServerDb;
  saveDb: (db: ServerDb) => void;
  requireAuth: (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => void;
  assertChildAccess: (
    req: AuthenticatedRequest,
    res: express.Response,
    childId: string,
  ) => StoredChildRecord | null | 'untracked-sample';
  requireAdminPermission: (permission: string) => express.RequestHandler;
}

const VALID_SURAH_ID_SET = new Set(QURAN_SURAHS.map((s) => s.id));
const VALID_RECITER_ID_SET = new Set(QURAN_RECITERS.map((r) => r.id));

function normalizeReciterIdInput(rawId: unknown): string {
  const clean = typeof rawId === 'string' ? rawId.trim() : '';
  if (clean === 'adult-husary-murattal') return 'adult-husary-muallim';
  return clean;
}

function recordQuranActiveDay(
  child: StoredChildRecord,
  event: Omit<ActivityTimelineEvent, 'id' | 'timestamp'>,
) {
  const today = getTodayDayKey();
  const monthKey = getCurrentMonthKey();

  child.monthlySnapshots = child.monthlySnapshots || {};
  if (!child.monthlySnapshots[monthKey]) {
    child.monthlySnapshots[monthKey] = buildMonthlySnapshotForChild(child, monthKey);
  }

  const days = new Set(child.activeDaysHistory || []);
  days.add(today);
  child.activeDaysHistory = Array.from(days).sort().slice(-90);
  child.learningStreakDays = calculateStreakDays(child.activeDaysHistory);

  child.activityTimeline = [
    {
      id: `evt_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...event,
    },
    ...(child.activityTimeline || []),
  ].slice(0, 120);
}

export function getEffectiveQuranChildSettings(
  db: ServerDb,
  childId: string,
): QuranChildSettings {
  ensureFamilyCollections(db);
  const existing = db.quranChildSettings![childId];
  const nowIso = new Date().toISOString();
  if (existing) {
    const validAllowed = (existing.allowedSurahIds || []).filter((id) => VALID_SURAH_ID_SET.has(id));
    const validOrder = (existing.surahOrder || []).filter((id) => VALID_SURAH_ID_SET.has(id));
    for (const id of DEFAULT_ALLOWED_SURAH_IDS) {
      if (!validOrder.includes(id)) validOrder.push(id);
    }
    return {
      ...existing,
      allowedSurahIds: validAllowed.length > 0 ? validAllowed : [...DEFAULT_ALLOWED_SURAH_IDS],
      surahOrder: validOrder,
      preferredReciterId: VALID_RECITER_ID_SET.has(existing.preferredReciterId)
        ? existing.preferredReciterId
        : 'adult-husary-muallim',
      repeatCount: clampQuranRepeatCount(existing.repeatCount, 2),
      dailyMaxMinutes: clampQuranDailyMinutes(existing.dailyMaxMinutes, 15),
    };
  }
  return {
    childId,
    enabled: true,
    allowedSurahIds: [...DEFAULT_ALLOWED_SURAH_IDS],
    surahOrder: [...DEFAULT_ALLOWED_SURAH_IDS],
    preferredReciterId: 'adult-husary-muallim',
    preferChildReciterFallback: true,
    repeatCount: 2,
    listenOnlyMode: false,
    dailyMaxMinutes: 15,
    gentleReminderEnabled: false,
    updatedAt: nowIso,
  };
}

const PHRASE_ASSET_DEFAULTS: Record<
  'basmala' | 'closing',
  {
    contentKey: 'phrase:basmala' | 'phrase:closing';
    phraseAr: string;
    labelEn: string;
    isQuranVerse: boolean;
    defaultSourceName: string;
    defaultLicense: string;
    envUrl?: string;
  }
> = {
  basmala: {
    contentKey: 'phrase:basmala',
    phraseAr: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
    labelEn: 'Opening Basmala (Pre-Surah)',
    isQuranVerse: true,
    defaultSourceName: 'Quran Foundation Recitation ID 6 (Al-Husary Murattal) / Approved Asset',
    defaultLicense: 'Pending administrator confirmation of Quran Foundation / licensed audio usage rights.',
    envUrl: process.env.QF_BASMALA_AUDIO_URL,
  },
  closing: {
    contentKey: 'phrase:closing',
    phraseAr: 'صَدَقَ اللَّهُ الْعَظِيمُ',
    labelEn: 'Closing Phrase — Sadaq Allah Al-Azeem (Non-Verse Post-Surah)',
    isQuranVerse: false,
    defaultSourceName: 'Not Configured (Requires Authentic Licensed Recording)',
    defaultLicense: 'No closing phrase recording configured or licensed yet. Kept disabled until approved.',
    envUrl: process.env.QF_CLOSING_PHRASE_AUDIO_URL,
  },
};

export function getPhraseAssetConfigs(db: ServerDb): {
  basmala: QuranPhraseAudioAssetConfig;
  closing: QuranPhraseAudioAssetConfig;
} {
  ensureFamilyCollections(db);
  const overrides = db.quranContentVerifications || {};

  const resolveOne = (phraseKey: 'basmala' | 'closing'): QuranPhraseAudioAssetConfig => {
    const def = PHRASE_ASSET_DEFAULTS[phraseKey];
    const record = overrides[def.contentKey];
    const metaJson = (record?.audioUrlsJson || {}) as Record<string, string>;
    const rawUrl = metaJson.url ?? def.envUrl ?? '';
    const safeUrl = normalizeQuranAudioUrl(rawUrl);

    const licenseConfirmed =
      record?.licenseTermsConfirmed === true || metaJson.licenseConfirmed === 'true';
    const humanListeningApproved =
      record?.tajweedListeningConfirmed === true || metaJson.humanListeningApproved === 'true';
    const verificationStatus: QuranVerificationStatus = record?.verificationStatus || 'pending_verification';
    const licenseOrPermission = record?.licenseOrPermission || def.defaultLicense;
    const reviewedBy = record?.tajweedReviewedBy || undefined;

    let status: QuranPhraseAssetStatus = 'not_configured';
    if (safeUrl && verificationStatus !== 'unavailable') {
      const fullyApproved =
        verificationStatus === 'verified' &&
        licenseConfirmed &&
        humanListeningApproved &&
        Boolean(licenseOrPermission.trim()) &&
        Boolean(reviewedBy?.trim());
      status = fullyApproved ? 'approved' : 'configured_pending_approval';
    }

    return {
      phraseKey,
      phraseAr: def.phraseAr,
      labelEn: def.labelEn,
      isQuranVerse: def.isQuranVerse,
      audioUrl: verificationStatus === 'unavailable' ? null : safeUrl,
      status,
      verificationStatus:
        verificationStatus === 'unavailable'
          ? 'unavailable'
          : status === 'approved'
            ? 'verified'
            : safeUrl
              ? 'pending_verification'
              : 'unavailable',
      sourceName: record?.sourceName || def.defaultSourceName,
      licenseOrPermission,
      licenseConfirmed,
      humanListeningApproved,
      reviewedBy,
      reviewedAt: record?.tajweedReviewedAt || undefined,
      notes: record?.notes || undefined,
    };
  };

  return {
    basmala: resolveOne('basmala'),
    closing: resolveOne('closing'),
  };
}

export const ADMIN_CONFIRMATION_POLICY_VERSIONS = {
  qfDeveloperTermsAndCommercialUse: 'QF-Terms-2026-11-20',
  qfAttributionAndReciterCredit: 'Quran.Foundation-Credit-v4',
  sevenDayCachePolicy: 'QF-7-Day-Cache-Policy',
  privacyAndTermsReadiness: 'NonoLand-Policy-2026.04',
  humanTajweedApproval: 'Curated-9-Surah-40-Ayah',
  basmalaAudioApproval: 'QF-Reciter-6-1:1',
} as const;

export function createEmptyAdminConfirmations(): QuranAdminConfirmations {
  return {
    qfDeveloperTermsAndCommercialUse: { confirmed: false },
    qfAttributionAndReciterCredit: { confirmed: false },
    sevenDayCachePolicy: { confirmed: false },
    privacyAndTermsReadiness: { confirmed: false },
    humanTajweedApproval: { confirmed: false },
    basmalaAudioApproval: { confirmed: false },
    qfAttributionAndTerms: { confirmed: false },
  };
}

export function normalizeSurahChecklist(
  rawChecklist?: Record<string, unknown> | null,
  fallbackChecklist?: Record<string, QuranSurahHumanReviewEntry> | null,
): Record<string, QuranSurahHumanReviewEntry> {
  const result: Record<string, QuranSurahHumanReviewEntry> = {};
  for (const surah of QURAN_SURAHS) {
    const rawEntry =
      rawChecklist && typeof rawChecklist === 'object' && rawChecklist[surah.id] && typeof rawChecklist[surah.id] === 'object'
        ? (rawChecklist[surah.id] as Record<string, unknown>)
        : fallbackChecklist?.[surah.id]
          ? (fallbackChecklist[surah.id] as unknown as Record<string, unknown>)
          : undefined;

    const rawAyahs = Array.isArray(rawEntry?.reviewedAyahNumbers) ? rawEntry!.reviewedAyahNumbers : [];
    const reviewedSet = new Set<number>();
    for (const num of rawAyahs) {
      const parsed = Number(num);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= surah.ayahCount) {
        reviewedSet.add(parsed);
      }
    }
    const reviewedAyahNumbers = Array.from(reviewedSet).sort((a, b) => a - b);
    const rawResult = typeof rawEntry?.reviewResult === 'string' ? rawEntry.reviewResult : 'pending';
    const reviewResult: QuranSurahReviewResult =
      rawResult === 'passed' || rawResult === 'issues_found' ? rawResult : 'pending';
    const reviewerName =
      typeof rawEntry?.reviewerName === 'string' ? sanitizeShortText(rawEntry.reviewerName, 120) : '';
    const rawDate = typeof rawEntry?.reviewDate === 'string' ? rawEntry.reviewDate.trim() : '';
    const reviewDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';
    const notes = typeof rawEntry?.notes === 'string' ? sanitizeQuranNote(rawEntry.notes, 280) : '';

    result[surah.id] = {
      surahId: surah.id,
      chapterNumber: surah.number,
      ayahCount: surah.ayahCount,
      reviewedAyahNumbers,
      reviewerName,
      reviewDate,
      reviewResult,
      notes,
    };
  }
  return result;
}

export function isSurahHumanReviewComplete(entry: QuranSurahHumanReviewEntry | undefined, expectedAyahCount: number): boolean {
  if (!entry) return false;
  return (
    entry.reviewResult === 'passed' &&
    entry.reviewerName.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) &&
    entry.notes.trim().length > 0 &&
    entry.reviewedAyahNumbers.length === expectedAyahCount
  );
}

export function computeChecklistProgress(checklist: Record<string, QuranSurahHumanReviewEntry>): {
  surahsPassedCount: number;
  surahsTotalCount: number;
  ayahsReviewedCount: number;
  ayahsTotalCount: number;
  allComplete: boolean;
  incompleteSurahs: string[];
} {
  let surahsPassedCount = 0;
  let ayahsReviewedCount = 0;
  let ayahsTotalCount = 0;
  const incompleteSurahs: string[] = [];

  for (const surah of QURAN_SURAHS) {
    ayahsTotalCount += surah.ayahCount;
    const entry = checklist[surah.id];
    if (entry) {
      ayahsReviewedCount += entry.reviewedAyahNumbers.length;
    }
    if (isSurahHumanReviewComplete(entry, surah.ayahCount)) {
      surahsPassedCount++;
    } else {
      incompleteSurahs.push(`${surah.nameEn} (${surah.number})`);
    }
  }

  return {
    surahsPassedCount,
    surahsTotalCount: QURAN_SURAHS.length,
    ayahsReviewedCount,
    ayahsTotalCount,
    allComplete: surahsPassedCount === QURAN_SURAHS.length && ayahsReviewedCount === ayahsTotalCount,
    incompleteSurahs,
  };
}

export function normalizeConfirmationEntry(
  checked: boolean,
  prev: QuranConfirmationItemRecord | undefined,
  actorName: string,
  nowIso: string,
  actorUserId?: string,
  policyVersion?: string,
): QuranConfirmationItemRecord {
  if (!checked) {
    return { confirmed: false };
  }
  if (prev?.confirmed && prev.confirmedBy && prev.confirmedAt) {
    return {
      confirmed: true,
      confirmedBy: prev.confirmedBy,
      ...(prev.confirmedByUserId || actorUserId
        ? { confirmedByUserId: prev.confirmedByUserId || actorUserId }
        : {}),
      confirmedAt: prev.confirmedAt,
      ...(policyVersion || prev.policyVersion
        ? { policyVersion: policyVersion || prev.policyVersion }
        : {}),
    };
  }
  return {
    confirmed: true,
    confirmedBy: actorName,
    ...(actorUserId ? { confirmedByUserId: actorUserId } : {}),
    confirmedAt: nowIso,
    ...(policyVersion ? { policyVersion } : {}),
  };
}

export function getBasmalaCandidateInfo(db: ServerDb): {
  audioUrl: string | null;
  verseKey: string;
  recitationId: number;
  reciterName: string;
  source: 'reciter_record' | 'provider_cache' | 'none';
} {
  ensureFamilyCollections(db);
  const record = db.quranContentVerifications?.[HUSARY_MURATTAL_SPEC.reciterId];
  const fromRecord = normalizeQuranAudioUrl(record?.ayahAudioUrlsJson?.['1:1']);
  if (fromRecord && isAllowedQuranFoundationAudioHost(fromRecord)) {
    return {
      audioUrl: fromRecord,
      verseKey: '1:1',
      recitationId: HUSARY_MURATTAL_SPEC.quranFoundationVerseRecitationId,
      reciterName: HUSARY_MURATTAL_SPEC.nameEn,
      source: 'reciter_record',
    };
  }
  const fromCache = normalizeQuranAudioUrl(getCachedHusaryBasmalaCandidateUrl());
  if (fromCache && isAllowedQuranFoundationAudioHost(fromCache)) {
    return {
      audioUrl: fromCache,
      verseKey: '1:1',
      recitationId: HUSARY_MURATTAL_SPEC.quranFoundationVerseRecitationId,
      reciterName: HUSARY_MURATTAL_SPEC.nameEn,
      source: 'provider_cache',
    };
  }
  return {
    audioUrl: null,
    verseKey: '1:1',
    recitationId: HUSARY_MURATTAL_SPEC.quranFoundationVerseRecitationId,
    reciterName: HUSARY_MURATTAL_SPEC.nameEn,
    source: 'none',
  };
}

function hydrateConfirmations(raw?: QuranAdminConfirmations): QuranAdminConfirmations {
  const legacyCombined = raw?.qfAttributionAndTerms;
  const qfDevTerms: QuranConfirmationItemRecord =
    raw?.qfDeveloperTermsAndCommercialUse ||
    (legacyCombined?.confirmed ? { ...legacyCombined } : { confirmed: false });
  const qfAttribution: QuranConfirmationItemRecord =
    raw?.qfAttributionAndReciterCredit ||
    (legacyCombined?.confirmed ? { ...legacyCombined } : { confirmed: false });
  const sevenDay = raw?.sevenDayCachePolicy || { confirmed: false };
  const privacy = raw?.privacyAndTermsReadiness || { confirmed: false };
  const tajweed = raw?.humanTajweedApproval || { confirmed: false };
  const basmala = raw?.basmalaAudioApproval || { confirmed: false };
  return {
    qfDeveloperTermsAndCommercialUse: qfDevTerms,
    qfAttributionAndReciterCredit: qfAttribution,
    sevenDayCachePolicy: sevenDay,
    privacyAndTermsReadiness: privacy,
    humanTajweedApproval: tajweed,
    basmalaAudioApproval: basmala,
    qfAttributionAndTerms: {
      confirmed: qfDevTerms.confirmed && qfAttribution.confirmed,
      confirmedBy: qfAttribution.confirmedBy || qfDevTerms.confirmedBy,
      confirmedByUserId: qfAttribution.confirmedByUserId || qfDevTerms.confirmedByUserId,
      confirmedAt: qfAttribution.confirmedAt || qfDevTerms.confirmedAt,
      policyVersion: qfDevTerms.policyVersion,
    },
  };
}

export function buildReleaseReadinessSummary(db: ServerDb, nowMs = Date.now()): QuranReleaseReadinessSummary {
  ensureFamilyCollections(db);
  const reciters = mergeRecitersWithVerifications(db, nowMs);
  const husary = reciters.find((r) => r.id === HUSARY_MURATTAL_SPEC.reciterId) || reciters[0];
  const record = db.quranContentVerifications?.[HUSARY_MURATTAL_SPEC.reciterId];
  const phraseAssets = getPhraseAssetConfigs(db);
  const checklist = normalizeSurahChecklist(record?.surahChecklist);
  const progress = computeChecklistProgress(checklist);
  const confirmations = hydrateConfirmations(record?.adminConfirmations);

  const fourAdminKeys = [
    confirmations.qfDeveloperTermsAndCommercialUse,
    confirmations.qfAttributionAndReciterCredit,
    confirmations.sevenDayCachePolicy,
    confirmations.privacyAndTermsReadiness,
  ];
  const adminConfirmationsCount = fourAdminKeys.filter((c) => c.confirmed).length;
  const adminConfirmationsTotal = fourAdminKeys.length;
  const allAdminConfirmationsComplete = adminConfirmationsCount === adminConfirmationsTotal;

  const surahAudioUrlsCount = QURAN_SURAHS.filter((s) =>
    Boolean(normalizeQuranAudioUrl(record?.audioUrlsJson?.[s.id])),
  ).length;
  const ayahAudioUrlsCount = QURAN_SURAHS.reduce(
    (acc, s) =>
      acc +
      s.ayahs.filter((a) => Boolean(normalizeQuranAudioUrl(record?.ayahAudioUrlsJson?.[a.verseKey]))).length,
    0,
  );
  const textIntegrityConfirmed = record?.textIntegrityConfirmed === true;
  const audioIntegrityConfirmed = record?.audioIntegrityConfirmed === true;
  const reciterIdentityConfirmed = record?.reciterIdentityConfirmed === true;
  const integrityChecksReady =
    textIntegrityConfirmed &&
    audioIntegrityConfirmed &&
    reciterIdentityConfirmed &&
    surahAudioUrlsCount === QURAN_SURAHS.length &&
    ayahAudioUrlsCount === progress.ayahsTotalCount;

  const reciterVerified = husary.verificationStatus === 'verified';
  const basmalaApproved = phraseAssets.basmala.status === 'approved';
  const closingDisabled = phraseAssets.closing.status !== 'approved';
  const featureEnabled = db.featureFlags?.quranWorldEnabled !== false;
  const familyAccessEnabled = reciterVerified && basmalaApproved && featureEnabled;

  const pendingApprovals: Array<{ key: string; labelEn: string; labelAr: string }> = [];
  if (!confirmations.qfDeveloperTermsAndCommercialUse.confirmed) {
    pendingApprovals.push({
      key: 'conf_qf_developer_terms',
      labelEn: 'Admin confirmation: Quran Foundation Developer Terms & permitted integrated commercial use',
      labelAr: 'تأكيد المشرف: شروط مطوري Quran Foundation والاستخدام التجاري المدمج المصرح به',
    });
  }
  if (!confirmations.qfAttributionAndReciterCredit.confirmed) {
    pendingApprovals.push({
      key: 'conf_qf_attribution',
      labelEn: 'Admin confirmation: Quran Foundation attribution and Reciter ID 6 (Al-Husary) credit',
      labelAr: 'تأكيد المشرف: إسناد Quran Foundation وذكر اسم القارئ الشيخ محمود خليل الحصري',
    });
  }
  if (!confirmations.sevenDayCachePolicy.confirmed) {
    pendingApprovals.push({
      key: 'conf_cache_policy',
      labelEn: 'Admin confirmation: Seven-day audio URL server cache policy',
      labelAr: 'تأكيد المشرف: سياسة التخزين المؤقت لروابط الصوت (٧ أيام)',
    });
  }
  if (!confirmations.privacyAndTermsReadiness.confirmed) {
    pendingApprovals.push({
      key: 'conf_privacy_terms',
      labelEn: 'Admin confirmation: Privacy Policy and Terms of Use readiness',
      labelAr: 'تأكيد المشرف: جاهزية سياسة الخصوصية وشروط الاستخدام',
    });
  }
  if (!progress.allComplete) {
    pendingApprovals.push({
      key: 'surah_checklist',
      labelEn: `Human Tajweed review checklist (${progress.surahsPassedCount}/${progress.surahsTotalCount} Surahs, ${progress.ayahsReviewedCount}/${progress.ayahsTotalCount} Ayahs passed)`,
      labelAr: `مراجعة التجويد البشرية (${progress.surahsPassedCount}/${progress.surahsTotalCount} سورة، ${progress.ayahsReviewedCount}/${progress.ayahsTotalCount} آية)`,
    });
  }
  if (!basmalaApproved) {
    pendingApprovals.push({
      key: 'basmala_audio',
      labelEn: `Basmala asset approval (QF Reciter ID 6 candidate 1:1 — status: ${phraseAssets.basmala.status})`,
      labelAr: `اعتماد صوت البسملة (مرشح 1:1 للقارئ رقم ٦ — الحالة: ${phraseAssets.basmala.status})`,
    });
  }
  if (!integrityChecksReady) {
    pendingApprovals.push({
      key: 'integrity_checks',
      labelEn: `Text, audio & reciter integrity checks (${surahAudioUrlsCount}/9 Surahs, ${ayahAudioUrlsCount}/40 Ayahs URLs loaded)`,
      labelAr: `فحوصات سلامة النص والصوت وهوية القارئ (${surahAudioUrlsCount}/9 سورة، ${ayahAudioUrlsCount}/40 آية)`,
    });
  }
  if (!reciterVerified) {
    pendingApprovals.push({
      key: 'reciter_release',
      labelEn: `Final release action: Approve Quran World for Families (${husary.verificationStatus} -> verified)`,
      labelAr: `الإجراء النهائي للإطلاق: اعتماد عالم القرآن للعائلات (${husary.verificationStatus} -> verified)`,
    });
  }

  const canApproveFamilyRelease =
    allAdminConfirmationsComplete &&
    progress.allComplete &&
    basmalaApproved &&
    integrityChecksReady;

  return {
    familyAccessEnabled,
    reciterVerified,
    reciterStatus: husary.verificationStatus,
    adminConfirmationsCount,
    adminConfirmationsTotal,
    allAdminConfirmationsComplete,
    surahsPassedCount: progress.surahsPassedCount,
    surahsTotalCount: progress.surahsTotalCount,
    ayahsReviewedCount: progress.ayahsReviewedCount,
    ayahsTotalCount: progress.ayahsTotalCount,
    tajweedReviewComplete: progress.allComplete,
    basmalaStatus: phraseAssets.basmala.status,
    basmalaApproved,
    closingStatus: phraseAssets.closing.status,
    closingDisabled,
    closingBlocksRelease: false,
    integrityChecksReady,
    textIntegrityConfirmed,
    audioIntegrityConfirmed,
    reciterIdentityConfirmed,
    surahAudioUrlsCount,
    ayahAudioUrlsCount,
    canApproveFamilyRelease,
    confirmations,
    pendingApprovals,
  };
}

export function mergeRecitersWithVerifications(
  db: ServerDb,
  nowMs = Date.now(),
): QuranReciterSpec[] {
  ensureFamilyCollections(db);
  const overrides = db.quranContentVerifications || {};
  const phraseAssets = getPhraseAssetConfigs(db);
  const approvedBasmalaUrl =
    phraseAssets.basmala.status === 'approved' ? phraseAssets.basmala.audioUrl || undefined : undefined;
  const approvedClosingUrl =
    phraseAssets.closing.status === 'approved' ? phraseAssets.closing.audioUrl || undefined : undefined;

  return QURAN_RECITERS.map((reciter) => {
    const v = overrides[reciter.id];
    if (!v || v.contentType !== 'reciter_audio') return reciter;
    const safeSurahUrls: Record<string, string> = {};
    for (const [k, url] of Object.entries(v.audioUrlsJson || {})) {
      if (k.startsWith('_')) continue;
      const normalized = normalizeQuranAudioUrl(url);
      if (normalized) safeSurahUrls[k] = normalized;
    }
    const safeAyahUrls: Record<string, string> = {};
    for (const [k, url] of Object.entries(v.ayahAudioUrlsJson || {})) {
      const normalized = normalizeQuranAudioUrl(url);
      if (normalized) safeAyahUrls[k] = normalized;
    }

    const usesExternalQfStream =
      /quran\s*foundation/i.test(v.sourceName || reciter.sourceName || '') ||
      Object.values(safeSurahUrls).some((u) => u.startsWith('https://')) ||
      Object.values(safeAyahUrls).some((u) => u.startsWith('https://'));

    const updatedAtMs = v.updatedAt ? Date.parse(v.updatedAt) : NaN;
    const qfCacheExpired =
      usesExternalQfStream &&
      (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > MAX_QF_SERVER_CACHE_MS);

    const activeSurahUrls = qfCacheExpired ? {} : safeSurahUrls;
    const activeAyahUrls = qfCacheExpired ? {} : safeAyahUrls;

    const hasAudioUrls =
      Object.keys(activeSurahUrls).length > 0 || Object.keys(activeAyahUrls).length > 0;
    const effectiveStatus: QuranVerificationStatus = qfCacheExpired
      ? 'pending_verification'
      : v.verificationStatus === 'verified' && !hasAudioUrls
        ? 'unavailable'
        : v.verificationStatus;
    return {
      ...reciter,
      sourceName: v.sourceName || reciter.sourceName,
      licenseOrPermission: v.licenseOrPermission || reciter.licenseOrPermission,
      tajweedReviewedBy: v.tajweedReviewedBy || reciter.tajweedReviewedBy,
      tajweedReviewedAt: v.tajweedReviewedAt || reciter.tajweedReviewedAt,
      verificationStatus: effectiveStatus,
      surahAudioUrls: Object.keys(activeSurahUrls).length > 0 ? activeSurahUrls : undefined,
      ayahAudioUrls: Object.keys(activeAyahUrls).length > 0 ? activeAyahUrls : undefined,
      basmalaAudioUrl: effectiveStatus === 'verified' ? approvedBasmalaUrl : undefined,
      closingPhraseAudioUrl: effectiveStatus === 'verified' ? approvedClosingUrl : undefined,
      unavailableReason: qfCacheExpired
        ? {
            ar: 'انتهت صلاحية التخزين المؤقت لروابط Quran Foundation (الحد الأقصى ٧ أيام) — يلزم إعادة المزامنة.',
            en: 'Quran Foundation cached URLs exceeded the 7-day compliance window and require re-sync.',
          }
        : effectiveStatus === 'verified'
          ? undefined
          : reciter.unavailableReason,
    };
  });
}

export function resolveReciterForPlayback(
  reciters: QuranReciterSpec[],
  preferredReciterId: string,
  preferChildFallback = true,
): {
  requestedReciter: QuranReciterSpec;
  activeReciter: QuranReciterSpec | null;
  usedAdultFallback: boolean;
  audioAvailable: boolean;
} {
  const requested =
    reciters.find((r) => r.id === preferredReciterId) ||
    reciters.find((r) => r.reciterType === 'adult') ||
    reciters[0];

  const isPlayableVerified = (r: QuranReciterSpec | undefined): boolean =>
    Boolean(
      r &&
        r.verificationStatus === 'verified' &&
        ((r.surahAudioUrls && Object.keys(r.surahAudioUrls).length > 0) ||
          (r.ayahAudioUrls && Object.keys(r.ayahAudioUrls).length > 0)),
    );

  if (isPlayableVerified(requested)) {
    return {
      requestedReciter: requested,
      activeReciter: requested,
      usedAdultFallback: false,
      audioAvailable: true,
    };
  }

  // Child reciter unavailable/pending -> fall back strictly to a verified adult reciter (never TTS)
  if (requested.reciterType === 'child' && preferChildFallback) {
    const verifiedAdult = reciters.find((r) => r.reciterType === 'adult' && isPlayableVerified(r));
    if (verifiedAdult) {
      return {
        requestedReciter: requested,
        activeReciter: verifiedAdult,
        usedAdultFallback: true,
        audioAvailable: true,
      };
    }
  } else {
    const otherVerifiedAdult = reciters.find((r) => r.reciterType === 'adult' && isPlayableVerified(r));
    if (otherVerifiedAdult) {
      return {
        requestedReciter: requested,
        activeReciter: otherVerifiedAdult,
        usedAdultFallback: true,
        audioAvailable: true,
      };
    }
  }

  return {
    requestedReciter: requested,
    activeReciter: null,
    usedAdultFallback: false,
    audioAvailable: false,
  };
}

export function computeNaturalSurahStatus(
  listenCount: number,
  repeatSessionsCount: number,
  ayahsPracticedCount: number,
  totalAyahs: number,
): Exclude<QuranMemorizationStatus, 'parent_confirmed'> {
  if (listenCount >= 3 && ayahsPracticedCount >= totalAyahs && totalAyahs > 0) {
    return 'familiar';
  }
  if (repeatSessionsCount >= 1 || ayahsPracticedCount >= 1) {
    return 'practiced';
  }
  if (listenCount >= 1) {
    return 'heard';
  }
  return 'not_started';
}

export function getChildQuranMinutesUsedToday(db: ServerDb, childId: string): number {
  const today = getTodayDayKey();
  const totalSeconds = (db.quranActivityEvents || [])
    .filter((ev) => ev.childId === childId && ev.occurredAt.slice(0, 10) === today)
    .reduce((sum, ev) => sum + Math.max(0, Number(ev.durationSeconds || 0)), 0);
  return Math.round((totalSeconds / 60) * 10) / 10;
}

export function buildChildQuranSummary(db: ServerDb, child: StoredChildRecord) {
  ensureFamilyCollections(db);
  const settings = getEffectiveQuranChildSettings(db, child.id);
  const reciters = mergeRecitersWithVerifications(db);
  const playback = resolveReciterForPlayback(
    reciters,
    settings.preferredReciterId,
    settings.preferChildReciterFallback,
  );

  const surahProgressList = Object.values(db.quranSurahProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const storyProgressList = Object.values(db.quranStoryProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const mannerProgressList = Object.values(db.quranMannerProgress || {}).filter(
    (p) => p.childId === child.id,
  );
  const recentEvents = (db.quranActivityEvents || [])
    .filter((ev) => ev.childId === child.id)
    .slice(0, 40);

  const minutesUsedToday = getChildQuranMinutesUsedToday(db, child.id);

  return {
    childId: child.id,
    internalAgeBand: getInternalAgeBand(child),
    featureEnabled: db.featureFlags?.quranWorldEnabled !== false,
    settings,
    playbackResolution: playback,
    minutesUsedToday,
    dailyLimitReached: minutesUsedToday >= settings.dailyMaxMinutes,
    surahProgress: surahProgressList,
    storyProgress: storyProgressList,
    mannerProgress: mannerProgressList,
    recentEvents,
    growthSummary: {
      listenedSurahsCount: surahProgressList.filter((s) => s.listenCount > 0).length,
      practicedSurahsCount: surahProgressList.filter((s) => s.repeatSessionsCount > 0).length,
      familiarSurahsCount: surahProgressList.filter(
        (s) => s.status === 'familiar' || s.status === 'parent_confirmed',
      ).length,
      parentConfirmedCount: surahProgressList.filter((s) => s.parentConfirmedMemorization).length,
      storiesReadCount: storyProgressList.filter((s) => s.completedCount > 0).length,
      mannersPracticedCount: mannerProgressList.reduce((acc, m) => acc + m.practicedCount, 0),
    },
  };
}

export function registerQuranRoutes({
  app,
  getDb,
  saveDb,
  requireAuth,
  assertChildAccess,
  requireAdminPermission,
}: QuranRoutesDeps) {
  // 1. Authenticated Catalog & Verified Provenance Registry
  app.get('/api/quran/catalog', requireAuth, (_req: AuthenticatedRequest, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    const reciters = mergeRecitersWithVerifications(db);
    const rawPhraseAssets = getPhraseAssetConfigs(db);
    // Strip unapproved phrase URLs from family/child catalog responses
    const sanitizeForFamily = (asset: QuranPhraseAudioAssetConfig): QuranPhraseAudioAssetConfig => ({
      ...asset,
      audioUrl: asset.status === 'approved' ? asset.audioUrl : null,
    });
    return res.json({
      quranSchemaReady: isQuranSchemaReady(),
      featureEnabled: db.featureFlags?.quranWorldEnabled !== false,
      attributionNotice: 'Quran data provided by Quran.Foundation.',
      surahs: QURAN_SURAHS,
      reciters,
      stories: QURAN_STORIES,
      manners: QURAN_MANNERS,
      playbackDefaultResolution: resolveReciterForPlayback(reciters, 'adult-husary-muallim', true),
      phraseAssets: {
        basmala: sanitizeForFamily(rawPhraseAssets.basmala),
        closing: sanitizeForFamily(rawPhraseAssets.closing),
      },
    });
  });

  // 1b. Read-only Quran Audio Provider & Single-Reciter Verification Status
  app.get('/api/quran/audio/status', requireAuth, (_req: AuthenticatedRequest, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    const reciters = mergeRecitersWithVerifications(db);
    const defaultReciter = reciters.find((r) => r.id === HUSARY_MURATTAL_SPEC.reciterId) || reciters[0];
    const scopeConfig = resolveConfiguredQuranFoundationScopes();
    const phraseAssets = getPhraseAssetConfigs(db);
    const releaseReadiness = buildReleaseReadinessSummary(db);
    return res.json({
      provider: 'quran-foundation',
      quranFoundationConfigured: isQuranFoundationConfigured(),
      oauthAuthMethod: 'client_secret_basic',
      configuredScopes: scopeConfig.scopes,
      scopeConfigSource: scopeConfig.source,
      attributionRequired: true,
      compliancePolicy: {
        termsUpdatedDate: '2026-11-20',
        maxServerCacheDays: MAX_QF_SERVER_CACHE_DAYS,
        testingCacheTtlMinutes: Math.round(TESTING_AUDIO_CACHE_TTL_MS / 60_000),
        directStreamingOnly: true,
        rehostingProhibited: true,
        rawUrlPackageExposed: false,
        requiredAttribution: 'Quran data provided by Quran.Foundation.',
        commercialEndUserUsePermitted: true,
        standaloneRedistributionAllowed: false,
        paidApiLicenseRequired: false,
        closingPhraseStatus: phraseAssets.closing.status,
        basmalaStatus: phraseAssets.basmala.status,
        familyAccessEnabled: releaseReadiness.familyAccessEnabled,
        pendingApprovalsCount: releaseReadiness.pendingApprovals.length,
        privacyPolicyUrl: '/privacy',
        termsOfUseUrl: '/terms',
      },
      singleDefaultReciter: {
        id: defaultReciter.id,
        canonicalSlug: HUSARY_MURATTAL_SPEC.canonicalSlug,
        nameAr: defaultReciter.name.ar,
        nameEn: defaultReciter.name.en,
        verificationStatus: defaultReciter.verificationStatus,
        verifiedSurahCount: Object.keys(defaultReciter.surahAudioUrls || {}).length,
        verifiedAyahCount: Object.keys(defaultReciter.ayahAudioUrls || {}).length,
        attribution: HUSARY_MURATTAL_SPEC.attribution,
      },
      technicalDiagnosticSampleUrl: '/assets/audio/technical-test-chime.wav',
    });
  });

  // 2. Child's Quran Settings, Progress & Age-Adapted Summary
  app.get('/api/children/:id/quran', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const child = assertChildAccess(req, res, req.params.id);
    if (!child || child === 'untracked-sample') {
      if (child === 'untracked-sample') return res.status(404).json({ error: 'Child profile not found' });
      return;
    }
    if (!canUserAccessChild(db, req.authSession!.user, child, 'view_progress')) {
      return res.status(403).json({ error: 'Forbidden: missing permission to view child Quran progress.' });
    }
    return res.json({
      quranSchemaReady: isQuranSchemaReady(),
      ...buildChildQuranSummary(db, child),
    });
  });

  // 3. Record Listen / Listen & Repeat Activity (NEVER confirms memorization!)
  app.post('/api/children/:id/quran/listen', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return {
          status: 503,
          body: {
            error: 'Quran World storage tables are pending additive migration 0002_quran_world.sql.',
            code: 'QURAN_SCHEMA_PENDING',
          },
        };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return {
          status: 403,
          body: { error: 'Quran World is currently disabled by platform administrators.', code: 'FEATURE_DISABLED' },
        };
      }

      const user = req.authSession!.user;
      if (!isChildOrStudentRole(user.role) && !canUserAccessChild(db, user, child, 'view_progress')) {
        return { status: 403, body: { error: 'Forbidden: cannot record activity for this child.' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return {
          status: 403,
          body: { error: 'Quran World is currently paused by a parent for this child.', code: 'QURAN_DISABLED_FOR_CHILD' },
        };
      }

      const body = (req.body || {}) as {
        surahId?: string;
        mode?: 'listen' | 'repeat';
        ayahNumbers?: number[];
        durationSeconds?: number;
        reciterId?: string;
      };

      const surahId = sanitizeShortText(body.surahId || '', 32);
      const surah = getQuranSurahById(surahId);
      if (!surah) {
        return { status: 400, body: { error: 'Invalid Surah identifier.' } };
      }
      if (!settings.allowedSurahIds.includes(surah.id)) {
        return {
          status: 403,
          body: { error: 'This Surah is not currently enabled in this child’s Quran plan.', code: 'SURAH_NOT_ALLOWED_FOR_CHILD' },
        };
      }

      const minutesUsedToday = getChildQuranMinutesUsedToday(db, child.id);
      if (minutesUsedToday >= settings.dailyMaxMinutes) {
        return {
          status: 429,
          body: {
            error: 'Daily Quran listening time limit reached. Let’s take a peaceful break!',
            code: 'QURAN_DAILY_LIMIT_REACHED',
            dailyLimitReached: true,
            minutesUsedToday,
            dailyMaxMinutes: settings.dailyMaxMinutes,
          },
        };
      }

      const mode: 'listen' | 'repeat' = body.mode === 'repeat' && !settings.listenOnlyMode ? 'repeat' : 'listen';
      const validAyahs = Array.isArray(body.ayahNumbers)
        ? Array.from(
            new Set(
              body.ayahNumbers
                .map((n) => Math.round(Number(n)))
                .filter((n) => Number.isFinite(n) && n >= 1 && n <= surah.ayahCount),
            ),
          )
        : [];
      const durationSeconds = Math.max(0, Math.min(1800, Math.round(Number(body.durationSeconds || 20))));
      const reciterId = VALID_RECITER_ID_SET.has(String(body.reciterId || ''))
        ? String(body.reciterId)
        : settings.preferredReciterId;

      const key = `${child.id}__${surah.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranSurahProgress![key];
      const mergedAyahs = Array.from(
        new Set([...(prev?.ayahsPracticed || []), ...validAyahs]),
      ).sort((a, b) => a - b);

      const nextListenCount = (prev?.listenCount || 0) + 1;
      const nextRepeatSessions = (prev?.repeatSessionsCount || 0) + (mode === 'repeat' ? 1 : 0);
      const naturalStatus = computeNaturalSurahStatus(
        nextListenCount,
        nextRepeatSessions,
        mergedAyahs.length,
        surah.ayahCount,
      );

      // Preserve prior explicit parent confirmation if already confirmed; NEVER confirm automatically
      const parentConfirmed = Boolean(prev?.parentConfirmedMemorization);
      const nextStatus: QuranMemorizationStatus = parentConfirmed ? 'parent_confirmed' : naturalStatus;

      const updatedProgress: QuranSurahProgress = {
        id: key,
        childId: child.id,
        surahId: surah.id,
        listenCount: nextListenCount,
        repeatSessionsCount: nextRepeatSessions,
        ayahsPracticed: mergedAyahs,
        status: nextStatus,
        parentConfirmedMemorization: parentConfirmed,
        parentConfirmedAt: prev?.parentConfirmedAt,
        parentConfirmedByUserId: prev?.parentConfirmedByUserId,
        parentNote: prev?.parentNote,
        lastListenedAt: nowIso,
        updatedAt: nowIso,
      };
      db.quranSurahProgress![key] = updatedProgress;

      const event: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: mode,
        targetId: surah.id,
        durationSeconds,
        ayahCount: validAyahs.length || surah.ayahCount,
        reciterId,
        recordedByUserId: user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [event, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      child.totalLearningMinutes = (child.totalLearningMinutes || 0) + Math.max(0, Math.round(durationSeconds / 60));
      recordQuranActiveDay(child, {
        category: 'quran',
        title: { ar: `الاستماع إلى ${surah.nameAr}`, en: `Quran Time: ${surah.nameEn}` },
        detail:
          mode === 'repeat'
            ? { ar: 'استماع وترديد هادئ في عالم القرآن', en: 'Calm listen & repeat session' }
            : { ar: 'جلسة استماع هادئة في عالم القرآن', en: 'Calm Quran listening moment' },
      });

      awardGardenMilestoneIdempotent(db, child, {
        milestoneKey: 'quran-first-listen',
        preferredItemId: 'garden-olive-tree',
        reason: { ar: 'أول لحظة استماع هادئة في عالم القرآن', en: 'First peaceful moment in Quran World' },
      });
      if (mode === 'repeat') {
        awardGardenMilestoneIdempotent(db, child, {
          milestoneKey: 'quran-repeat-explorer',
          preferredItemId: 'garden-star-lantern',
          reason: { ar: 'الترديد اللطيف لآيات القرآن الكريم', en: 'Gentle listen & repeat in Quran World' },
        });
      }

      return {
        status: 200,
        body: {
          progress: updatedProgress,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 4. Record Quran Story Engagement (Symbolic only, non-competitive)
  app.post('/api/children/:id/quran/story', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }
      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return { status: 403, body: { error: 'Quran World is disabled.', code: 'FEATURE_DISABLED' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return { status: 403, body: { error: 'Quran World is disabled for this child.', code: 'QURAN_DISABLED_FOR_CHILD' } };
      }

      const storyId = sanitizeShortText(req.body?.storyId || '', 64);
      const story = getQuranStoryById(storyId);
      if (!story) {
        return { status: 400, body: { error: 'Invalid Quran story identifier.' } };
      }

      const key = `${child.id}__${story.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranStoryProgress![key];
      const next: QuranStoryProgress = {
        id: key,
        childId: child.id,
        storyId: story.id,
        completedCount: (prev?.completedCount || 0) + 1,
        lastReadAt: nowIso,
      };
      db.quranStoryProgress![key] = next;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'story',
        targetId: story.id,
        durationSeconds: 30,
        ayahCount: 0,
        recordedByUserId: req.authSession!.user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      recordQuranActiveDay(child, {
        category: 'quran',
        title: story.title,
        detail: { ar: 'قصة قرآنية مصوّرة برموز هادئة', en: 'Completed a symbolic Quran story' },
      });

      return {
        status: 200,
        body: {
          storyProgress: next,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 5. Record Islamic Manner Practice
  app.post('/api/children/:id/quran/manner', requireAuth, async (req: AuthenticatedRequest, res) => {
    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }
      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }
      if (db.featureFlags?.quranWorldEnabled === false) {
        return { status: 403, body: { error: 'Quran World is disabled.', code: 'FEATURE_DISABLED' } };
      }

      const settings = getEffectiveQuranChildSettings(db, child.id);
      if (!settings.enabled) {
        return { status: 403, body: { error: 'Quran World is disabled for this child.', code: 'QURAN_DISABLED_FOR_CHILD' } };
      }

      const mannerId = sanitizeShortText(req.body?.mannerId || '', 64);
      const manner = getQuranMannerById(mannerId);
      if (!manner) {
        return { status: 400, body: { error: 'Invalid Islamic manner identifier.' } };
      }

      const key = `${child.id}__${manner.id}`;
      const nowIso = new Date().toISOString();
      const prev = db.quranMannerProgress![key];
      const next: QuranMannerProgress = {
        id: key,
        childId: child.id,
        mannerId: manner.id,
        practicedCount: (prev?.practicedCount || 0) + 1,
        lastPracticedAt: nowIso,
      };
      db.quranMannerProgress![key] = next;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'manner',
        targetId: manner.id,
        durationSeconds: 15,
        ayahCount: 0,
        recordedByUserId: req.authSession!.user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      ensureChildFamilyAndGarden(db, child);
      recordQuranActiveDay(child, {
        category: 'quran',
        title: manner.title,
        detail: { ar: `تطبيق أدب إسلامي جميل: ${manner.phraseAr}`, en: `Practiced daily manner: ${manner.transliteration}` },
      });

      awardGardenMilestoneIdempotent(db, child, {
        milestoneKey: 'quran-kind-manners',
        preferredItemId: 'garden-family-blossom',
        reason: { ar: 'ممارسة أدب إسلامي جميل اليوم', en: 'Practiced a kind Islamic manner today' },
      });

      return {
        status: 200,
        body: {
          mannerProgress: next,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 6. Parent-Gated Quran Settings Update (Parent / Authorized Guardian Only)
  app.put('/api/children/:id/quran/settings', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!requireParentGate(req, res)) return;

    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }

      const user = req.authSession!.user;
      if (!canUserAccessChild(db, user, child, 'manage_learning_settings')) {
        return {
          status: 403,
          body: { error: 'Forbidden: manage_learning_settings permission required.', code: 'GUARDIAN_PERMISSION_DENIED' },
        };
      }

      const current = getEffectiveQuranChildSettings(db, child.id);
      const body = (req.body || {}) as Partial<QuranChildSettings>;

      const nextAllowed = Array.isArray(body.allowedSurahIds)
        ? body.allowedSurahIds.filter((id) => typeof id === 'string' && VALID_SURAH_ID_SET.has(id))
        : current.allowedSurahIds;

      const rawOrder = Array.isArray(body.surahOrder)
        ? body.surahOrder.filter((id) => typeof id === 'string' && VALID_SURAH_ID_SET.has(id))
        : current.surahOrder;
      const dedupOrder = Array.from(new Set(rawOrder));
      for (const id of DEFAULT_ALLOWED_SURAH_IDS) {
        if (!dedupOrder.includes(id)) dedupOrder.push(id);
      }

      const normalizedReciter = normalizeReciterIdInput(body.preferredReciterId);
      const preferredReciterId =
        normalizedReciter && VALID_RECITER_ID_SET.has(normalizedReciter)
          ? normalizedReciter
          : current.preferredReciterId;

      const nowIso = new Date().toISOString();
      const updated: QuranChildSettings = {
        childId: child.id,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        allowedSurahIds: nextAllowed.length > 0 ? Array.from(new Set(nextAllowed)) : current.allowedSurahIds,
        surahOrder: dedupOrder,
        preferredReciterId,
        preferChildReciterFallback:
          typeof body.preferChildReciterFallback === 'boolean'
            ? body.preferChildReciterFallback
            : current.preferChildReciterFallback,
        repeatCount:
          body.repeatCount !== undefined ? clampQuranRepeatCount(body.repeatCount, current.repeatCount) : current.repeatCount,
        listenOnlyMode: typeof body.listenOnlyMode === 'boolean' ? body.listenOnlyMode : current.listenOnlyMode,
        dailyMaxMinutes:
          body.dailyMaxMinutes !== undefined
            ? clampQuranDailyMinutes(body.dailyMaxMinutes, current.dailyMaxMinutes)
            : current.dailyMaxMinutes,
        gentleReminderEnabled:
          typeof body.gentleReminderEnabled === 'boolean'
            ? body.gentleReminderEnabled
            : current.gentleReminderEnabled,
        updatedByUserId: user.id,
        updatedAt: nowIso,
      };
      db.quranChildSettings![child.id] = updated;

      if (child.familyId) {
        recordFamilyEvent(db, {
          familyId: child.familyId,
          category: 'learning',
          actionType: 'QURAN_SETTINGS_UPDATED',
          actorId: user.id,
          actorName: user.displayName,
          actorRole: user.role,
          childId: child.id,
          childName: child.displayName,
          title: { ar: 'تحديث إعدادات عالم القرآن الكريم', en: 'Quran World settings updated' },
          description: {
            ar: `حدّث ${user.displayName} إعدادات عالم القرآن للطفل ${child.displayName} (مفعّل=${updated.enabled}، الحد اليومي=${updated.dailyMaxMinutes} د)`,
            en: `${user.displayName} updated Quran World settings for ${child.displayName} (enabled=${updated.enabled}, max=${updated.dailyMaxMinutes}m)`,
          },
          ip: getClientIp(req),
        });
      }

      return {
        status: 200,
        body: {
          settings: updated,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 7. Parent-Only Explicit Memorization Confirmation (Parent Gate + approve_content)
  app.post('/api/children/:id/quran/memorization-confirm', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!requireParentGate(req, res)) return;

    const outcome = await runWithPgDbLock(`child:${req.params.id}`, async (db) => {
      ensureFamilyCollections(db);
      const child = assertChildAccess(req, res, req.params.id);
      if (!child || child === 'untracked-sample') {
        if (child === 'untracked-sample') return { status: 404, body: { error: 'Child profile not found' } };
        return null;
      }

      if (!isQuranSchemaReady()) {
        return { status: 503, body: { error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' } };
      }

      const user = req.authSession!.user;
      if (!canUserAccessChild(db, user, child, 'approve_content')) {
        return {
          status: 403,
          body: { error: 'Forbidden: approve_content permission required to confirm memorization.', code: 'GUARDIAN_PERMISSION_DENIED' },
        };
      }

      const body = (req.body || {}) as {
        surahId?: string;
        confirmed?: boolean;
        parentNote?: string;
      };

      const surahId = sanitizeShortText(body.surahId || '', 32);
      const surah = getQuranSurahById(surahId);
      if (!surah) {
        return { status: 400, body: { error: 'Invalid Surah identifier.' } };
      }

      const confirmed = Boolean(body.confirmed);
      const cleanNote = body.parentNote !== undefined ? sanitizeQuranNote(body.parentNote, 280) : undefined;
      const key = `${child.id}__${surah.id}`;
      const prev = db.quranSurahProgress![key];
      const nowIso = new Date().toISOString();

      const naturalStatus = computeNaturalSurahStatus(
        prev?.listenCount || 0,
        prev?.repeatSessionsCount || 0,
        (prev?.ayahsPracticed || []).length,
        surah.ayahCount,
      );

      const updated: QuranSurahProgress = {
        id: key,
        childId: child.id,
        surahId: surah.id,
        listenCount: prev?.listenCount || 0,
        repeatSessionsCount: prev?.repeatSessionsCount || 0,
        ayahsPracticed: prev?.ayahsPracticed || [],
        status: confirmed ? 'parent_confirmed' : naturalStatus,
        parentConfirmedMemorization: confirmed,
        parentConfirmedAt: confirmed ? nowIso : undefined,
        parentConfirmedByUserId: confirmed ? user.id : undefined,
        parentNote: cleanNote !== undefined ? cleanNote || undefined : prev?.parentNote,
        lastListenedAt: prev?.lastListenedAt,
        updatedAt: nowIso,
      };
      db.quranSurahProgress![key] = updated;

      const qEvent: QuranActivityEvent = {
        id: `qevt_${crypto.randomBytes(5).toString('hex')}`,
        childId: child.id,
        eventType: 'parent_confirm',
        targetId: surah.id,
        durationSeconds: 0,
        ayahCount: surah.ayahCount,
        recordedByUserId: user.id,
        occurredAt: nowIso,
      };
      db.quranActivityEvents = [qEvent, ...(db.quranActivityEvents || [])].slice(0, 2000);

      if (child.familyId) {
        recordFamilyEvent(db, {
          familyId: child.familyId,
          category: 'learning',
          actionType: confirmed ? 'QURAN_MEMORIZATION_CONFIRMED' : 'QURAN_MEMORIZATION_UNCONFIRMED',
          actorId: user.id,
          actorName: user.displayName,
          actorRole: user.role,
          childId: child.id,
          childName: child.displayName,
          title: confirmed
            ? { ar: `اعتماد حفظ ${surah.nameAr} بواسطة ولي الأمر`, en: `Parent confirmed ${surah.nameEn} memorization` }
            : { ar: `إلغاء اعتماد حفظ ${surah.nameAr}`, en: `Parent cleared ${surah.nameEn} confirmation` },
          description: {
            ar: confirmed
              ? `أكّد ${user.displayName} حفظ الطفل ${child.displayName} لسورة ${surah.nameAr}`
              : `أعاد ${user.displayName} حالة حفظ ${surah.nameAr} للمتابعة المستمرة`,
            en: confirmed
              ? `${user.displayName} confirmed ${child.displayName} memorized ${surah.nameEn}`
              : `${user.displayName} reset parent memorization confirmation for ${surah.nameEn}`,
          },
          ip: getClientIp(req),
        });
      }

      return {
        status: 200,
        body: {
          progress: updated,
          summary: buildChildQuranSummary(db, child),
        },
      };
    });

    if (!outcome) return;
    return res.status(outcome.status).json(outcome.body);
  });

  // 8. Admin Provenance & Recitation Verification Registry (manage_lessons RBAC)
  app.get('/api/admin/quran/verifications', requireAdminPermission('manage_lessons'), (_req, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    const phraseAssets = getPhraseAssetConfigs(db);
    const releaseReadiness = buildReleaseReadinessSummary(db);
    return res.json({
      surahTexts: QURAN_SURAHS.map((s) => ({
        contentKey: s.id,
        contentType: 'surah_text' as const,
        nameAr: s.nameAr,
        nameEn: s.nameEn,
        ayahCount: s.ayahCount,
        textSource: s.textSource,
        textSourceUrl: s.textSourceUrl,
        textSha256: s.textSha256,
        verificationStatus: s.textVerificationStatus,
      })),
      reciters: mergeRecitersWithVerifications(db),
      phraseAssets,
      releaseReadiness,
      basmalaCandidate: getBasmalaCandidateInfo(db),
      customRecords: Object.values(db.quranContentVerifications || {}),
      licenseAndAttribution: QURAN_FOUNDATION_LICENSE_INFO,
      compliancePolicy: {
        termsUpdatedDate: '2026-11-20',
        maxServerCacheDays: MAX_QF_SERVER_CACHE_DAYS,
        testingCacheTtlMinutes: Math.round(TESTING_AUDIO_CACHE_TTL_MS / 60_000),
        directStreamingOnly: true,
        rehostingProhibited: true,
        rawUrlPackageExposed: false,
        requiredAttribution: 'Quran data provided by Quran.Foundation.',
        commercialEndUserUsePermitted: true,
        standaloneRedistributionAllowed: false,
        paidApiLicenseRequired: false,
        closingPhraseStatus: phraseAssets.closing.status,
        basmalaStatus: phraseAssets.basmala.status,
        familyAccessEnabled: releaseReadiness.familyAccessEnabled,
        privacyPolicyUrl: '/privacy',
        termsOfUseUrl: '/terms',
      },
    });
  });

  // 8a-1. Persist Individual Administrator Confirmation (manage_lessons RBAC)
  app.put('/api/admin/quran/release-confirmations/:confirmationKey', requireAdminPermission('manage_lessons'), (req: AuthenticatedRequest, res) => {
    if (!isQuranSchemaReady()) {
      return res.status(503).json({ error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' });
    }
    const rawConfKey = sanitizeShortText(req.params.confirmationKey || '', 64);
    const allowedConfKeys = new Set([
      'qfDeveloperTermsAndCommercialUse',
      'qfAttributionAndReciterCredit',
      'sevenDayCachePolicy',
      'privacyAndTermsReadiness',
    ] as const);
    type EditableConfKey =
      | 'qfDeveloperTermsAndCommercialUse'
      | 'qfAttributionAndReciterCredit'
      | 'sevenDayCachePolicy'
      | 'privacyAndTermsReadiness';

    if (!allowedConfKeys.has(rawConfKey as EditableConfKey)) {
      return res.status(404).json({ error: 'Unknown Quran release confirmation key.' });
    }
    const confKey = rawConfKey as EditableConfKey;

    const db = getDb();
    ensureFamilyCollections(db);
    const reciterId = HUSARY_MURATTAL_SPEC.reciterId;
    const reciter = getQuranReciterById(reciterId)!;
    const prevRecord = db.quranContentVerifications?.[reciterId];
    const nowIso = new Date().toISOString();
    const actorUserId = req.authSession?.user.id;
    const actorName = sanitizeShortText(
      req.authSession?.user.displayName || req.authSession?.user.email || actorUserId || 'admin',
      120,
    );

    const body = (req.body || {}) as { confirmed?: boolean; policyVersion?: string };
    const confirmed = body.confirmed === true;
    const customPolicyVersion =
      typeof body.policyVersion === 'string' && body.policyVersion.trim()
        ? sanitizeShortText(body.policyVersion.trim(), 64)
        : ADMIN_CONFIRMATION_POLICY_VERSIONS[confKey];

    const hydratedPrev = hydrateConfirmations(prevRecord?.adminConfirmations);
    const updatedItem: QuranConfirmationItemRecord = confirmed
      ? {
          confirmed: true,
          confirmedBy: actorName,
          ...(actorUserId ? { confirmedByUserId: actorUserId } : {}),
          confirmedAt: nowIso,
          policyVersion: customPolicyVersion,
        }
      : { confirmed: false };

    const nextConfirmations: QuranAdminConfirmations = {
      ...hydratedPrev,
      [confKey]: updatedItem,
    };
    const bothTermsAndCredit =
      nextConfirmations.qfDeveloperTermsAndCommercialUse.confirmed &&
      nextConfirmations.qfAttributionAndReciterCredit.confirmed;
    nextConfirmations.qfAttributionAndTerms = {
      confirmed: bothTermsAndCredit,
      ...(bothTermsAndCredit
        ? {
            confirmedBy: actorName,
            ...(actorUserId ? { confirmedByUserId: actorUserId } : {}),
            confirmedAt: nowIso,
            policyVersion: nextConfirmations.qfDeveloperTermsAndCommercialUse.policyVersion,
          }
        : {}),
    };

    const all4Confirmed =
      bothTermsAndCredit &&
      nextConfirmations.sevenDayCachePolicy.confirmed &&
      nextConfirmations.privacyAndTermsReadiness.confirmed;

    // Fail-closed: revoking any mandatory confirmation automatically moves verification back to pending_verification
    const nextVerificationStatus: QuranVerificationStatus =
      !all4Confirmed && prevRecord?.verificationStatus === 'verified'
        ? 'pending_verification'
        : prevRecord?.verificationStatus || 'pending_verification';

    const record: QuranContentVerificationRecord = {
      id: prevRecord?.id || `qver_${reciterId}`,
      contentType: 'reciter_audio',
      contentKey: reciterId,
      sourceName: prevRecord?.sourceName || reciter.sourceName,
      licenseOrPermission: prevRecord?.licenseOrPermission || reciter.licenseOrPermission,
      tajweedReviewedBy: prevRecord?.tajweedReviewedBy,
      tajweedReviewedAt: prevRecord?.tajweedReviewedAt,
      textIntegrityConfirmed: prevRecord?.textIntegrityConfirmed,
      audioIntegrityConfirmed: prevRecord?.audioIntegrityConfirmed,
      reciterIdentityConfirmed: prevRecord?.reciterIdentityConfirmed,
      tajweedListeningConfirmed: prevRecord?.tajweedListeningConfirmed,
      licenseTermsConfirmed: all4Confirmed,
      licenseConfirmedBy: all4Confirmed ? actorName : undefined,
      licenseConfirmedAt: all4Confirmed ? nowIso : undefined,
      surahChecklist: prevRecord?.surahChecklist,
      adminConfirmations: nextConfirmations,
      verificationStatus: nextVerificationStatus,
      audioUrlsJson: prevRecord?.audioUrlsJson,
      ayahAudioUrlsJson: prevRecord?.ayahAudioUrlsJson,
      notes: prevRecord?.notes,
      updatedByUserId: actorUserId,
      updatedAt: nowIso,
    };
    db.quranContentVerifications![reciterId] = record;

    recordAuditEvent(db, {
      eventType: 'CONTENT_REVIEW',
      actorId: actorUserId || 'admin',
      actorRole: req.authSession?.user.role || 'admin',
      actionType: 'QURAN_ADMIN_CONFIRMATION_UPDATED',
      recordType: 'quran_content_verification',
      recordId: reciterId,
      newValue: {
        confirmationKey: confKey,
        confirmed,
        policyVersion: updatedItem.policyVersion,
        verificationStatus: record.verificationStatus,
      },
      summary: `Updated Quran release confirmation ${confKey}=${confirmed} by ${actorName}`,
      ip: getClientIp(req),
    });

    saveDb(db);
    return res.json({
      confirmationKey: confKey,
      confirmation: updatedItem,
      verification: record,
      releaseReadiness: buildReleaseReadinessSummary(db),
    });
  });

  // 8a-2. Persist Human Tajweed Review (Per-Surah or Full 9-Surah / 40-Ayah Checklist + Optional Integrity Flags, Never Auto-Approves)
  app.put('/api/admin/quran/tajweed-review', requireAdminPermission('manage_lessons'), (req: AuthenticatedRequest, res) => {
    if (!isQuranSchemaReady()) {
      return res.status(503).json({ error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' });
    }
    const db = getDb();
    ensureFamilyCollections(db);
    const reciterId = HUSARY_MURATTAL_SPEC.reciterId;
    const reciter = getQuranReciterById(reciterId)!;
    const prevRecord = db.quranContentVerifications?.[reciterId];
    const nowIso = new Date().toISOString();
    const actorUserId = req.authSession?.user.id;
    const actorName = sanitizeShortText(
      req.authSession?.user.displayName || req.authSession?.user.email || actorUserId || 'admin',
      120,
    );

    const body = (req.body || {}) as {
      surahChecklist?: Record<string, unknown>;
      surahReview?: {
        surahId?: string;
        reviewerName?: string;
        reviewDate?: string;
        reviewResult?: QuranSurahReviewResult;
        reviewedAyahNumbers?: number[];
        notes?: string;
      };
      audioUrlsJson?: Record<string, string>;
      ayahAudioUrlsJson?: Record<string, string>;
      textIntegrityConfirmed?: boolean;
      audioIntegrityConfirmed?: boolean;
      reciterIdentityConfirmed?: boolean;
    };

    // Merge optional single Surah review patch onto existing checklist
    let mergedRawChecklist: Record<string, unknown> | undefined =
      body.surahChecklist && typeof body.surahChecklist === 'object' ? { ...body.surahChecklist } : undefined;
    if (body.surahReview && typeof body.surahReview.surahId === 'string') {
      const targetSurah = getQuranSurahById(sanitizeShortText(body.surahReview.surahId, 32));
      if (!targetSurah) {
        return res.status(400).json({ error: 'Invalid Surah identifier in Tajweed review.' });
      }
      mergedRawChecklist = {
        ...(prevRecord?.surahChecklist || {}),
        ...(mergedRawChecklist || {}),
        [targetSurah.id]: {
          ...(prevRecord?.surahChecklist?.[targetSurah.id] || {}),
          ...body.surahReview,
          surahId: targetSurah.id,
        },
      };
    }

    const surahChecklist = normalizeSurahChecklist(mergedRawChecklist, prevRecord?.surahChecklist);
    const checklistProgress = computeChecklistProgress(surahChecklist);

    // Optionally validate & save verified QF audio URLs if submitted
    let nextSurahAudioUrls = prevRecord?.audioUrlsJson;
    if (body.audioUrlsJson && typeof body.audioUrlsJson === 'object') {
      const cleanUrls: Record<string, string> = {};
      for (const [surahId, rawUrl] of Object.entries(body.audioUrlsJson)) {
        if (surahId.startsWith('_')) continue;
        const normalizedUrl = normalizeQuranAudioUrl(rawUrl);
        if (!normalizedUrl || !isAllowedQuranFoundationAudioHost(normalizedUrl)) {
          return res.status(400).json({
            error: `Unsafe or non-Quran-Foundation Surah audio URL for ${surahId}.`,
          });
        }
        cleanUrls[sanitizeShortText(surahId, 32)] = normalizedUrl;
      }
      nextSurahAudioUrls = cleanUrls;
    }

    let nextAyahAudioUrls = prevRecord?.ayahAudioUrlsJson;
    if (body.ayahAudioUrlsJson && typeof body.ayahAudioUrlsJson === 'object') {
      const cleanAyahUrls: Record<string, string> = {};
      for (const [verseKey, rawUrl] of Object.entries(body.ayahAudioUrlsJson)) {
        if (!/^\d{1,3}:\d{1,3}$/.test(verseKey)) continue;
        const normalizedUrl = normalizeQuranAudioUrl(rawUrl);
        if (!normalizedUrl || !isAllowedQuranFoundationAudioHost(normalizedUrl)) {
          return res.status(400).json({
            error: `Unsafe or non-Quran-Foundation Ayah audio URL for ${verseKey}.`,
          });
        }
        cleanAyahUrls[verseKey] = normalizedUrl;
      }
      nextAyahAudioUrls = cleanAyahUrls;
    }

    const prevConfs = hydrateConfirmations(prevRecord?.adminConfirmations);
    const latestReviewer =
      Object.values(surahChecklist)
        .map((e) => e.reviewerName.trim())
        .find(Boolean) || prevRecord?.tajweedReviewedBy;
    const latestReviewDate =
      Object.values(surahChecklist)
        .map((e) => e.reviewDate.trim())
        .find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) || prevRecord?.tajweedReviewedAt;

    const nextConfirmations: QuranAdminConfirmations = {
      ...prevConfs,
      humanTajweedApproval: checklistProgress.allComplete
        ? {
            confirmed: true,
            confirmedBy: latestReviewer || actorName,
            ...(actorUserId ? { confirmedByUserId: actorUserId } : {}),
            confirmedAt: nowIso,
            policyVersion: ADMIN_CONFIRMATION_POLICY_VERSIONS.humanTajweedApproval,
          }
        : { confirmed: false },
    };

    const nextTextIntegrity =
      typeof body.textIntegrityConfirmed === 'boolean'
        ? body.textIntegrityConfirmed
        : prevRecord?.textIntegrityConfirmed;
    const nextAudioIntegrity =
      typeof body.audioIntegrityConfirmed === 'boolean'
        ? body.audioIntegrityConfirmed
        : prevRecord?.audioIntegrityConfirmed;
    const nextReciterIdentity =
      typeof body.reciterIdentityConfirmed === 'boolean'
        ? body.reciterIdentityConfirmed
        : prevRecord?.reciterIdentityConfirmed;

    // Never auto-publish; and fail-closed if an incomplete/needs-correction review is saved
    const nextVerificationStatus: QuranVerificationStatus =
      !checklistProgress.allComplete && prevRecord?.verificationStatus === 'verified'
        ? 'pending_verification'
        : prevRecord?.verificationStatus || 'pending_verification';

    const record: QuranContentVerificationRecord = {
      id: prevRecord?.id || `qver_${reciterId}`,
      contentType: 'reciter_audio',
      contentKey: reciterId,
      sourceName: prevRecord?.sourceName || reciter.sourceName,
      licenseOrPermission: prevRecord?.licenseOrPermission || reciter.licenseOrPermission,
      tajweedReviewedBy: latestReviewer || undefined,
      tajweedReviewedAt: latestReviewDate || undefined,
      textIntegrityConfirmed: nextTextIntegrity,
      audioIntegrityConfirmed: nextAudioIntegrity,
      reciterIdentityConfirmed: nextReciterIdentity,
      tajweedListeningConfirmed: checklistProgress.allComplete,
      licenseTermsConfirmed: prevRecord?.licenseTermsConfirmed,
      licenseConfirmedBy: prevRecord?.licenseConfirmedBy,
      licenseConfirmedAt: prevRecord?.licenseConfirmedAt,
      surahChecklist,
      adminConfirmations: nextConfirmations,
      verificationStatus: nextVerificationStatus,
      audioUrlsJson: nextSurahAudioUrls,
      ayahAudioUrlsJson: nextAyahAudioUrls,
      notes: prevRecord?.notes,
      updatedByUserId: actorUserId,
      updatedAt: nowIso,
    };
    db.quranContentVerifications![reciterId] = record;

    recordAuditEvent(db, {
      eventType: 'CONTENT_REVIEW',
      actorId: actorUserId || 'admin',
      actorRole: req.authSession?.user.role || 'admin',
      actionType: 'QURAN_TAJWEED_REVIEW_UPDATED',
      recordType: 'quran_content_verification',
      recordId: reciterId,
      newValue: {
        surahsPassedCount: checklistProgress.surahsPassedCount,
        ayahsReviewedCount: checklistProgress.ayahsReviewedCount,
        allComplete: checklistProgress.allComplete,
        verificationStatus: record.verificationStatus,
      },
      summary: `Saved human Tajweed review (${checklistProgress.surahsPassedCount}/9 Surahs, ${checklistProgress.ayahsReviewedCount}/40 Ayahs)`,
      ip: getClientIp(req),
    });

    saveDb(db);
    return res.json({
      verification: record,
      reciters: mergeRecitersWithVerifications(db),
      releaseReadiness: buildReleaseReadinessSummary(db),
    });
  });

  app.put('/api/admin/quran/verifications/:key', requireAdminPermission('manage_lessons'), (req: AuthenticatedRequest, res) => {
    if (!isQuranSchemaReady()) {
      return res.status(503).json({ error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' });
    }
    const db = getDb();
    ensureFamilyCollections(db);
    const rawKey = sanitizeShortText(req.params.key || '', 64);
    const key = normalizeReciterIdInput(rawKey);
    const reciter = getQuranReciterById(key);
    if (!reciter) {
      return res.status(404).json({
        error: 'Unknown Quran reciter verification key. Quran Surah text cannot be edited via admin verification.',
      });
    }

    const body = (req.body || {}) as {
      sourceName?: string;
      licenseOrPermission?: string;
      tajweedReviewedBy?: string;
      tajweedReviewedAt?: string;
      textIntegrityConfirmed?: boolean;
      audioIntegrityConfirmed?: boolean;
      reciterIdentityConfirmed?: boolean;
      tajweedListeningConfirmed?: boolean;
      licenseTermsConfirmed?: boolean;
      licenseConfirmedBy?: string;
      surahChecklist?: Record<string, unknown>;
      adminConfirmations?: Partial<{
        qfAttributionAndTerms: boolean;
        sevenDayCachePolicy: boolean;
        privacyAndTermsReadiness: boolean;
        humanTajweedApproval: boolean;
        basmalaAudioApproval: boolean;
      }>;
      verificationStatus?: QuranVerificationStatus;
      audioUrlsJson?: Record<string, string>;
      ayahAudioUrlsJson?: Record<string, string>;
      notes?: string;
    };

    const allowedStatuses: QuranVerificationStatus[] = ['verified', 'pending_verification', 'unavailable'];
    const nextStatus = allowedStatuses.includes(body.verificationStatus as QuranVerificationStatus)
      ? (body.verificationStatus as QuranVerificationStatus)
      : 'pending_verification';

    const cleanUrls: Record<string, string> = {};
    if (body.audioUrlsJson && typeof body.audioUrlsJson === 'object') {
      for (const [surahId, rawUrl] of Object.entries(body.audioUrlsJson)) {
        if (!VALID_SURAH_ID_SET.has(surahId)) continue;
        const normalizedUrl = normalizeQuranAudioUrl(rawUrl);
        if (!normalizedUrl) {
          return res.status(400).json({
            error: `Unsafe or invalid audio URL for ${surahId}. Only https:// or /assets/quran/ paths are permitted.`,
          });
        }
        cleanUrls[surahId] = normalizedUrl;
      }
    }

    const cleanAyahUrls: Record<string, string> = {};
    if (body.ayahAudioUrlsJson && typeof body.ayahAudioUrlsJson === 'object') {
      for (const [verseKey, rawUrl] of Object.entries(body.ayahAudioUrlsJson)) {
        if (!/^\d{1,3}:\d{1,3}$/.test(verseKey)) continue;
        const normalizedUrl = normalizeQuranAudioUrl(rawUrl);
        if (!normalizedUrl) {
          return res.status(400).json({
            error: `Unsafe or invalid ayah audio URL for ${verseKey}. Only https:// or /assets/quran/ paths are permitted.`,
          });
        }
        cleanAyahUrls[verseKey] = normalizedUrl;
      }
    }

    const prevRecord = db.quranContentVerifications?.[reciter.id];
    const nowIso = new Date().toISOString();
    const actorName = sanitizeShortText(
      req.authSession?.user.displayName || req.authSession?.user.email || req.authSession?.user.id || 'admin',
      120,
    );

    const surahChecklist = normalizeSurahChecklist(body.surahChecklist, prevRecord?.surahChecklist);
    const checklistProgress = computeChecklistProgress(surahChecklist);
    const phraseAssets = getPhraseAssetConfigs(db);

    const actorUserId = req.authSession?.user.id;
    const prevConfs = hydrateConfirmations(prevRecord?.adminConfirmations);
    const reqConfs = (body.adminConfirmations || {}) as Record<string, unknown>;

    const qfDevTermsChecked =
      typeof reqConfs.qfDeveloperTermsAndCommercialUse === 'boolean'
        ? reqConfs.qfDeveloperTermsAndCommercialUse
        : typeof reqConfs.qfAttributionAndTerms === 'boolean'
          ? reqConfs.qfAttributionAndTerms
          : body.licenseTermsConfirmed === true
            ? true
            : prevConfs.qfDeveloperTermsAndCommercialUse.confirmed;
    const qfAttributionChecked =
      typeof reqConfs.qfAttributionAndReciterCredit === 'boolean'
        ? reqConfs.qfAttributionAndReciterCredit
        : typeof reqConfs.qfAttributionAndTerms === 'boolean'
          ? reqConfs.qfAttributionAndTerms
          : body.licenseTermsConfirmed === true
            ? true
            : prevConfs.qfAttributionAndReciterCredit.confirmed;
    const sevenDayCacheChecked =
      typeof reqConfs.sevenDayCachePolicy === 'boolean'
        ? reqConfs.sevenDayCachePolicy
        : Boolean(prevConfs.sevenDayCachePolicy?.confirmed);
    const privacyTermsChecked =
      typeof reqConfs.privacyAndTermsReadiness === 'boolean'
        ? reqConfs.privacyAndTermsReadiness
        : Boolean(prevConfs.privacyAndTermsReadiness?.confirmed);
    const humanTajweedChecked =
      typeof reqConfs.humanTajweedApproval === 'boolean'
        ? reqConfs.humanTajweedApproval
        : body.tajweedListeningConfirmed === true
          ? true
          : prevConfs.humanTajweedApproval.confirmed || checklistProgress.allComplete;
    const basmalaApprovalChecked =
      typeof reqConfs.basmalaAudioApproval === 'boolean'
        ? reqConfs.basmalaAudioApproval
        : phraseAssets.basmala.status === 'approved'
          ? true
          : Boolean(prevConfs.basmalaAudioApproval?.confirmed);

    if (basmalaApprovalChecked && phraseAssets.basmala.status !== 'approved') {
      return res.status(400).json({
        error: 'Cannot confirm Basmala audio approval until the QF Reciter ID 6 Basmala (1:1) candidate is explicitly listened to, usage rights confirmed, and saved as approved.',
      });
    }

    if (humanTajweedChecked && !checklistProgress.allComplete) {
      return res.status(400).json({
        error: `Cannot confirm human recitation/Tajweed approval until all 9 Surahs (40 Ayahs) are marked passed with reviewer name, date, and notes. Incomplete: ${checklistProgress.incompleteSurahs.join(', ')}.`,
      });
    }

    const qfDeveloperTermsAndCommercialUse = normalizeConfirmationEntry(
      qfDevTermsChecked,
      prevConfs.qfDeveloperTermsAndCommercialUse,
      actorName,
      nowIso,
      actorUserId,
      ADMIN_CONFIRMATION_POLICY_VERSIONS.qfDeveloperTermsAndCommercialUse,
    );
    const qfAttributionAndReciterCredit = normalizeConfirmationEntry(
      qfAttributionChecked,
      prevConfs.qfAttributionAndReciterCredit,
      actorName,
      nowIso,
      actorUserId,
      ADMIN_CONFIRMATION_POLICY_VERSIONS.qfAttributionAndReciterCredit,
    );

    const adminConfirmations: QuranAdminConfirmations = {
      qfDeveloperTermsAndCommercialUse,
      qfAttributionAndReciterCredit,
      sevenDayCachePolicy: normalizeConfirmationEntry(
        sevenDayCacheChecked,
        prevConfs.sevenDayCachePolicy,
        actorName,
        nowIso,
        actorUserId,
        ADMIN_CONFIRMATION_POLICY_VERSIONS.sevenDayCachePolicy,
      ),
      privacyAndTermsReadiness: normalizeConfirmationEntry(
        privacyTermsChecked,
        prevConfs.privacyAndTermsReadiness,
        actorName,
        nowIso,
        actorUserId,
        ADMIN_CONFIRMATION_POLICY_VERSIONS.privacyAndTermsReadiness,
      ),
      humanTajweedApproval: normalizeConfirmationEntry(
        humanTajweedChecked,
        prevConfs.humanTajweedApproval,
        actorName,
        nowIso,
        actorUserId,
        ADMIN_CONFIRMATION_POLICY_VERSIONS.humanTajweedApproval,
      ),
      basmalaAudioApproval: normalizeConfirmationEntry(
        basmalaApprovalChecked,
        prevConfs.basmalaAudioApproval,
        actorName,
        nowIso,
        actorUserId,
        ADMIN_CONFIRMATION_POLICY_VERSIONS.basmalaAudioApproval,
      ),
      qfAttributionAndTerms: normalizeConfirmationEntry(
        qfDevTermsChecked && qfAttributionChecked,
        prevConfs.qfAttributionAndTerms,
        actorName,
        nowIso,
        actorUserId,
        ADMIN_CONFIRMATION_POLICY_VERSIONS.qfDeveloperTermsAndCommercialUse,
      ),
    };

    const cleanSource = sanitizeShortText(body.sourceName || prevRecord?.sourceName || reciter.sourceName, 160);
    const cleanLicense = sanitizeShortText(
      body.licenseOrPermission || prevRecord?.licenseOrPermission || reciter.licenseOrPermission,
      200,
    );
    const derivedReviewer = Object.values(surahChecklist)
      .map((s) => s.reviewerName.trim())
      .find(Boolean);
    const cleanReviewer = body.tajweedReviewedBy
      ? sanitizeShortText(body.tajweedReviewedBy, 120)
      : prevRecord?.tajweedReviewedBy || derivedReviewer || undefined;
    const cleanReviewedAt = body.tajweedReviewedAt
      ? sanitizeShortText(body.tajweedReviewedAt, 40)
      : prevRecord?.tajweedReviewedAt || undefined;

    const textIntegrityConfirmed =
      typeof body.textIntegrityConfirmed === 'boolean'
        ? body.textIntegrityConfirmed
        : prevRecord?.textIntegrityConfirmed === true;
    const audioIntegrityConfirmed =
      typeof body.audioIntegrityConfirmed === 'boolean'
        ? body.audioIntegrityConfirmed
        : prevRecord?.audioIntegrityConfirmed === true;
    const reciterIdentityConfirmed =
      typeof body.reciterIdentityConfirmed === 'boolean'
        ? body.reciterIdentityConfirmed
        : prevRecord?.reciterIdentityConfirmed === true;
    const tajweedListeningConfirmed = adminConfirmations.humanTajweedApproval.confirmed;
    const licenseTermsConfirmed =
      adminConfirmations.qfDeveloperTermsAndCommercialUse.confirmed &&
      adminConfirmations.qfAttributionAndReciterCredit.confirmed &&
      adminConfirmations.sevenDayCachePolicy.confirmed &&
      adminConfirmations.privacyAndTermsReadiness.confirmed;

    if (nextStatus === 'verified') {
      const missingSurahUrls = QURAN_SURAHS.filter((s) => !cleanUrls[s.id]).map((s) => s.nameEn);
      const missingAyahUrlsCount = QURAN_SURAHS.reduce(
        (acc, s) => acc + s.ayahs.filter((a) => !cleanAyahUrls[a.verseKey]).length,
        0,
      );
      const missingConfirmations: string[] = [];
      if (!textIntegrityConfirmed) missingConfirmations.push('textIntegrityConfirmed');
      if (!audioIntegrityConfirmed) missingConfirmations.push('audioIntegrityConfirmed');
      if (!reciterIdentityConfirmed) missingConfirmations.push('reciterIdentityConfirmed');
      if (!adminConfirmations.qfDeveloperTermsAndCommercialUse.confirmed) {
        missingConfirmations.push('qfDeveloperTermsAndCommercialUse');
      }
      if (!adminConfirmations.qfAttributionAndReciterCredit.confirmed) {
        missingConfirmations.push('qfAttributionAndReciterCredit');
      }
      if (!adminConfirmations.sevenDayCachePolicy.confirmed) missingConfirmations.push('sevenDayCachePolicy');
      if (!adminConfirmations.privacyAndTermsReadiness.confirmed) {
        missingConfirmations.push('privacyAndTermsReadiness');
      }
      if (!adminConfirmations.humanTajweedApproval.confirmed) missingConfirmations.push('humanTajweedApproval');
      if (!adminConfirmations.basmalaAudioApproval.confirmed) missingConfirmations.push('basmalaAudioApproval');

      if (!checklistProgress.allComplete) {
        return res.status(400).json({
          error: `Cannot verify/release Reciter ID 6 until all 9 curated Surahs and 40 Ayahs pass human review with reviewer name, date, and notes. Incomplete: ${checklistProgress.incompleteSurahs.join(', ')}.`,
        });
      }
      if (phraseAssets.basmala.status !== 'approved') {
        return res.status(400).json({
          error: 'Cannot verify/release Reciter ID 6 until the QF Reciter ID 6 Basmala (1:1) audio asset is approved.',
        });
      }
      if (missingSurahUrls.length > 0 || missingAyahUrlsCount > 0) {
        return res.status(400).json({
          error: `Cannot verify/release Reciter ID 6 without all 9 Surah and 40 Ayah HTTPS URLs (missing Surahs: ${missingSurahUrls.join(', ') || 'none'}; missing Ayah URLs: ${missingAyahUrlsCount}).`,
        });
      }
      if (!cleanLicense || !cleanReviewer || missingConfirmations.length > 0) {
        return res.status(400).json({
          error:
            missingConfirmations.length > 0
              ? `Cannot mark reciter audio as verified until all explicit administrator confirmations are completed: ${missingConfirmations.join(', ')}.`
              : 'Cannot mark reciter audio as verified without licenseOrPermission and tajweedReviewedBy.',
        });
      }
    }

    const cleanLicenseConfirmedBy = licenseTermsConfirmed
      ? sanitizeShortText(
          body.licenseConfirmedBy || actorName,
          120,
        )
      : undefined;

    const record: QuranContentVerificationRecord = {
      id: `qver_${reciter.id}`,
      contentType: 'reciter_audio',
      contentKey: reciter.id,
      sourceName: cleanSource,
      licenseOrPermission: cleanLicense,
      tajweedReviewedBy: cleanReviewer,
      tajweedReviewedAt: cleanReviewedAt,
      textIntegrityConfirmed,
      audioIntegrityConfirmed,
      reciterIdentityConfirmed,
      tajweedListeningConfirmed,
      licenseTermsConfirmed,
      licenseConfirmedBy: cleanLicenseConfirmedBy,
      licenseConfirmedAt: licenseTermsConfirmed
        ? prevRecord?.licenseTermsConfirmed && prevRecord?.licenseConfirmedAt
          ? prevRecord.licenseConfirmedAt
          : nowIso
        : undefined,
      surahChecklist,
      adminConfirmations,
      verificationStatus: nextStatus,
      audioUrlsJson: Object.keys(cleanUrls).length > 0 ? cleanUrls : undefined,
      ayahAudioUrlsJson: Object.keys(cleanAyahUrls).length > 0 ? cleanAyahUrls : undefined,
      notes: body.notes ? sanitizeQuranNote(body.notes, 280) : undefined,
      updatedByUserId: req.authSession?.user.id,
      updatedAt: nowIso,
    };
    db.quranContentVerifications![reciter.id] = record;

    recordAuditEvent(db, {
      eventType: 'CONTENT_REVIEW',
      actorId: req.authSession?.user.id || 'admin',
      actorRole: req.authSession?.user.role || 'admin',
      actionType: 'QURAN_VERIFICATION_UPDATED',
      recordType: 'quran_content_verification',
      recordId: reciter.id,
      newValue: {
        verificationStatus: record.verificationStatus,
        sourceName: record.sourceName,
        surahUrlsCount: Object.keys(cleanUrls).length,
        ayahUrlsCount: Object.keys(cleanAyahUrls).length,
        surahsPassedCount: checklistProgress.surahsPassedCount,
        ayahsReviewedCount: checklistProgress.ayahsReviewedCount,
        adminConfirmations,
      },
      summary: `Updated Quran verification provenance for ${reciter.id} -> ${record.verificationStatus} (${checklistProgress.surahsPassedCount}/9 Surahs)`,
      ip: getClientIp(req),
    });

    saveDb(db);
    return res.json({
      verification: record,
      reciters: mergeRecitersWithVerifications(db),
      releaseReadiness: buildReleaseReadinessSummary(db),
    });
  });

  // 8b. Admin Opening Basmala & Closing Phrase Audio Configuration (never auto-verifies or modifies reciter status)
  app.put('/api/admin/quran/phrase-assets/:phraseKey', requireAdminPermission('manage_lessons'), (req: AuthenticatedRequest, res) => {
    if (!isQuranSchemaReady()) {
      return res.status(503).json({ error: 'Quran World tables are pending migration.', code: 'QURAN_SCHEMA_PENDING' });
    }
    const rawPhraseKey = sanitizeShortText(req.params.phraseKey || '', 32);
    if (rawPhraseKey !== 'basmala' && rawPhraseKey !== 'closing') {
      return res.status(404).json({ error: 'Unknown Quran phrase asset key. Expected "basmala" or "closing".' });
    }
    const phraseKey = rawPhraseKey;
    const def = PHRASE_ASSET_DEFAULTS[phraseKey];

    const body = (req.body || {}) as {
      audioUrl?: string;
      sourceName?: string;
      licenseOrPermission?: string;
      licenseConfirmed?: boolean;
      humanListeningApproved?: boolean;
      reviewedBy?: string;
      reviewedAt?: string;
      verificationStatus?: QuranVerificationStatus;
      notes?: string;
    };

    const rawUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
    let cleanAudioUrl: string | null = null;
    if (rawUrl) {
      cleanAudioUrl = normalizeQuranAudioUrl(rawUrl);
      if (!cleanAudioUrl) {
        return res.status(400).json({
          error: `Unsafe or invalid ${phraseKey} audio URL. Only https:// or /assets/quran/ paths are permitted.`,
        });
      }
      if (phraseKey === 'basmala') {
        if (!isAllowedQuranFoundationAudioHost(cleanAudioUrl)) {
          return res.status(400).json({
            error: 'Basmala audio must use the verified Quran Foundation Reciter ID 6 (Al-Husary 1:1) HTTPS candidate URL.',
          });
        }
        const dbSnapshot = getDb();
        const reciterRecord = dbSnapshot.quranContentVerifications?.[HUSARY_MURATTAL_SPEC.reciterId];
        const expectedCandidate =
          reciterRecord?.ayahAudioUrlsJson?.['1:1'] || getCachedHusaryBasmalaCandidateUrl();
        if (expectedCandidate && cleanAudioUrl !== expectedCandidate) {
          return res.status(400).json({
            error: `Basmala URL must match the verified Quran Foundation Reciter ID 6 (1:1) candidate (${expectedCandidate}).`,
          });
        }
      }
    }

    const licenseConfirmed = body.licenseConfirmed === true;
    const humanListeningApproved = body.humanListeningApproved === true;
    const cleanSource = sanitizeShortText(body.sourceName || def.defaultSourceName, 160);
    const cleanLicense = sanitizeShortText(body.licenseOrPermission || def.defaultLicense, 240);
    const cleanReviewer = body.reviewedBy ? sanitizeShortText(body.reviewedBy, 120) : undefined;
    const rawReviewedAt = typeof body.reviewedAt === 'string' ? body.reviewedAt.trim() : '';
    const cleanReviewedAt = /^\d{4}-\d{2}-\d{2}$/.test(rawReviewedAt) ? rawReviewedAt : undefined;
    const requestedStatus: QuranVerificationStatus =
      body.verificationStatus === 'verified' || body.verificationStatus === 'unavailable'
        ? body.verificationStatus
        : 'pending_verification';

    if (requestedStatus === 'verified') {
      const missing: string[] = [];
      if (!cleanAudioUrl) missing.push('audioUrl');
      if (!licenseConfirmed) missing.push('licenseConfirmed');
      if (!humanListeningApproved) missing.push('humanListeningApproved');
      if (!cleanLicense) missing.push('licenseOrPermission');
      if (!cleanReviewer) missing.push('reviewedBy');
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Cannot mark ${phraseKey} audio asset as approved/verified until required fields are completed: ${missing.join(', ')}.`,
        });
      }
    }

    const db = getDb();
    ensureFamilyCollections(db);
    const nowIso = new Date().toISOString();
    const record: QuranContentVerificationRecord = {
      id: `qver_phrase_${phraseKey}`,
      contentType: 'reciter_audio',
      contentKey: def.contentKey,
      sourceName: cleanSource,
      licenseOrPermission: cleanLicense,
      tajweedReviewedBy: cleanReviewer,
      tajweedReviewedAt: cleanReviewer ? cleanReviewedAt || nowIso.slice(0, 10) : undefined,
      tajweedListeningConfirmed: humanListeningApproved,
      licenseTermsConfirmed: licenseConfirmed,
      verificationStatus: cleanAudioUrl ? requestedStatus : 'unavailable',
      audioUrlsJson: {
        ...(cleanAudioUrl ? { url: cleanAudioUrl } : {}),
        licenseConfirmed: String(licenseConfirmed),
        humanListeningApproved: String(humanListeningApproved),
      },
      notes: body.notes ? sanitizeQuranNote(body.notes, 280) : undefined,
      updatedByUserId: req.authSession?.user.id,
      updatedAt: nowIso,
    };
    db.quranContentVerifications![def.contentKey] = record;

    // If Basmala was unapproved/disabled, also clear basmalaAudioApproval confirmation on Reciter ID 6
    if (phraseKey === 'basmala' && (requestedStatus !== 'verified' || !cleanAudioUrl)) {
      const rec = db.quranContentVerifications?.[HUSARY_MURATTAL_SPEC.reciterId];
      if (rec?.adminConfirmations?.basmalaAudioApproval?.confirmed) {
        rec.adminConfirmations.basmalaAudioApproval = { confirmed: false };
      }
    }

    recordAuditEvent(db, {
      eventType: 'CONTENT_REVIEW',
      actorId: req.authSession?.user.id || 'admin',
      actorRole: req.authSession?.user.role || 'admin',
      actionType: 'QURAN_PHRASE_ASSET_UPDATED',
      recordType: 'quran_content_verification',
      recordId: def.contentKey,
      newValue: {
        phraseKey,
        hasAudioUrl: Boolean(cleanAudioUrl),
        licenseConfirmed,
        humanListeningApproved,
        reviewedBy: cleanReviewer,
        verificationStatus: record.verificationStatus,
      },
      summary: `Updated Quran ${phraseKey} phrase audio config (status=${record.verificationStatus})`,
      ip: getClientIp(req),
    });

    saveDb(db);
    const phraseAssets = getPhraseAssetConfigs(db);
    return res.json({
      phraseKey,
      asset: phraseAssets[phraseKey],
      phraseAssets,
      releaseReadiness: buildReleaseReadinessSummary(db),
    });
  });

  // 9. Admin Quran Foundation Metadata Preview (strictly server-side credentials, never auto-verifies)
  app.post('/api/admin/quran/qf-sync-preview', requireAdminPermission('manage_lessons'), async (_req: AuthenticatedRequest, res) => {
    const chapterNumbers = QURAN_SURAHS.map((s) => s.number);
    console.info(`[QF-Preview] Handler invoked: route=/api/admin/quran/qf-sync-preview chapters=${chapterNumbers.length}`);
    const preview = await fetchHusaryRecitationMetadata(chapterNumbers);
    const surahCount = Object.keys(preview.surahAudioUrls).length;
    const ayahCount = Object.keys(preview.ayahAudioUrls).length;
    const hasAudio = surahCount > 0 || ayahCount > 0;
    const oauthHttpStatus = preview.diagnostics.oauthPrimary?.httpStatus ?? 'none';
    const chapterOk = preview.diagnostics.chapterApi?.ok ?? false;
    const reciterVerified = preview.diagnostics.reciterCheck?.verifiedHusaryId6 ?? 'none';
    const requestedScopesStr = preview.diagnostics.requestedScopes.join(' ') || 'none';
    const grantedScopesStr = preview.diagnostics.grantedScopes.join(' ') || 'none';

    if (!preview.configured) {
      console.info(
        `[QF-Preview] Handler returning JSON: status=200 ok=false upstreamHttpStatus=503 configured=false surahs=${surahCount} ayahs=${ayahCount}`,
      );
      return res.status(200).json({
        ...preview,
        ok: false,
        upstreamHttpStatus: 503,
        error: preview.error || 'QF_CREDENTIALS_NOT_CONFIGURED',
        verificationStatus: 'pending_verification',
        licenseAndAttribution: preview.validation.licenseAndAttribution,
        notice:
          'QF_CLIENT_ID and QF_CLIENT_SECRET are not configured on the server.',
      });
    }

    if (preview.error || !hasAudio) {
      console.info(
        `[QF-Preview] Handler returning JSON: status=200 ok=false upstreamHttpStatus=502 configured=true requestedScopes="${requestedScopesStr}" grantedScopes="${grantedScopesStr}" oauthHttpStatus=${oauthHttpStatus} chapterOk=${chapterOk} reciterVerified=${reciterVerified} surahs=${surahCount} ayahs=${ayahCount}`,
      );
      return res.status(200).json({
        ...preview,
        ok: false,
        upstreamHttpStatus: 502,
        error: preview.error || 'NO_RECITATION_AUDIO_FOUND',
        verificationStatus: 'pending_verification',
        licenseAndAttribution: preview.validation.licenseAndAttribution,
        notice:
          'Preview failed. Inspect diagnostics (requested scopes, granted scopes, OAuth status, Chapter API status, Reciter verification, and Audio API status). No audio was verified.',
      });
    }

    console.info(
      `[QF-Preview] Handler returning JSON: status=200 configured=true ok=true requestedScopes="${requestedScopesStr}" grantedScopes="${grantedScopesStr}" oauthHttpStatus=${oauthHttpStatus} chapterOk=${chapterOk} reciterVerified=${reciterVerified} surahs=${surahCount} ayahs=${ayahCount}`,
    );
    return res.status(200).json({
      ...preview,
      ok: true,
      verificationStatus: 'pending_verification',
      licenseAndAttribution: preview.validation.licenseAndAttribution,
      notice:
        'Validation preview only (auto-approve disabled). Admin must review text integrity, audio playability, Reciter ID 6 Tajweed review, and license terms before marking any reciter verified.',
    });
  });

  // 10. Admin Controlled Internal Testing Audio URLs (ADMIN/INTERNAL TESTING ONLY, never auto-verifies, never exposed to children/families)
  app.get('/api/admin/quran/internal-testing-audio', requireAdminPermission('manage_lessons'), async (req: AuthenticatedRequest, res) => {
    const db = getDb();
    ensureFamilyCollections(db);
    const phraseAssets = getPhraseAssetConfigs(db);
    const chapterNumbers = QURAN_SURAHS.map((s) => s.number);
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await fetchHusaryTestingAudioUrls(chapterNumbers, forceRefresh);
    const basmalaIncludedBySurah: Record<string, boolean> = {
      ...result.basmalaIncludedBySurah,
    };
    for (const s of QURAN_SURAHS) {
      if (basmalaIncludedBySurah[s.id] === undefined) {
        // Surah 1 (Al-Fatihah) includes 1:1 Basmala in its recording; other 8 Surahs start at Ayah 1 without Basmala
        basmalaIncludedBySurah[s.id] = !s.hasOpeningBasmalah;
      }
    }
    const testingBasmalaUrl = phraseAssets.basmala.audioUrl || result.basmalaCandidateAudioUrl || null;
    const testingBasmalaSource = phraseAssets.basmala.audioUrl
      ? 'admin_configured'
      : result.basmalaCandidateAudioUrl
        ? 'qf_1_1_candidate'
        : 'none';
    const testingClosingUrl = phraseAssets.closing.audioUrl || null;

    return res.status(200).json({
      ...result,
      basmalaIncludedBySurah,
      phraseAssets,
      testingBasmalaUrl,
      testingBasmalaSource,
      testingClosingUrl,
      verificationStatus: 'pending_verification',
      autoApproved: false,
      autoPublished: false,
      releasedToFamilies: false,
      testingMode: 'ADMIN_INTERNAL_TESTING_ONLY',
      displayedAttribution:
        "Quran data provided by Quran.Foundation. · Recitation: Sheikh Mahmoud Khalil Al-Husary – Hafs 'an Asim – Murattal",
      curatedSurahsCount: QURAN_SURAHS.length,
      curatedAyahsCount: QURAN_SURAHS.reduce((sum, s) => sum + s.ayahCount, 0),
    });
  });
}
