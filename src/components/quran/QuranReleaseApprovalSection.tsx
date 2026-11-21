import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, RefreshCw, Save, ShieldCheck, Volume2 } from 'lucide-react';
import { QURAN_SURAHS } from '../../data/quranCatalog';
import type {
  QuranAdminConfirmations,
  QuranPhraseAudioAssetConfig,
  QuranReciterSpec,
  QuranSurahHumanReviewEntry,
  QuranSurahReviewResult,
} from '../../types/nonoland';
import type { AdminQuranVerificationsPayload } from './QuranSharedTypes';
import type { QfPreviewState } from './qfDiagnosticsHelpers';

type AdminConfirmationKey =
  | 'qfDeveloperTermsAndCommercialUse'
  | 'qfAttributionAndReciterCredit'
  | 'sevenDayCachePolicy'
  | 'privacyAndTermsReadiness';

interface Props {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  data: AdminQuranVerificationsPayload | null;
  qfConfigured: boolean;
  qfPreview: QfPreviewState | null;
  language: 'ar' | 'en';
  onReload: () => Promise<void>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

interface InternalTestingCandidatePayload {
  configured?: boolean;
  basmalaCandidateAudioUrl?: string | null;
  surahAudioUrls?: Record<string, string>;
  ayahAudioUrls?: Record<string, string>;
  error?: string;
}

const CONFIRMATION_ITEMS: Array<{
  key: AdminConfirmationKey;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  policyVersion: string;
}> = [
  {
    key: 'qfDeveloperTermsAndCommercialUse',
    titleEn: 'Quran Foundation Developer Terms & Permitted Integrated Commercial Use',
    titleAr: 'شروط مطوري Quran Foundation والاستخدام التجاري المدمج المسموح',
    descriptionEn:
      'Confirms compliance with Quran Foundation Developer Terms (updated Nov 20, 2026): end-user integrated app use permitted without standalone redistribution or separate paid API licensing.',
    policyVersion: 'QF-Terms-2026-11-20',
  },
  {
    key: 'qfAttributionAndReciterCredit',
    titleEn: 'Quran Foundation Attribution & Reciter Credit',
    titleAr: 'إسناد Quran Foundation وذكر اسم القارئ',
    descriptionEn:
      'Confirms accessible attribution "Quran data provided by Quran.Foundation." and reciter credit "Sheikh Mahmoud Khalil Al-Husary – Hafs \'an Asim – Murattal".',
    policyVersion: 'Quran.Foundation-Credit-v4',
  },
  {
    key: 'sevenDayCachePolicy',
    titleEn: 'Seven-Day Audio URL Cache Policy',
    titleAr: 'سياسة الاحتفاظ المؤقت بروابط الصوت لمدة ٧ أيام',
    descriptionEn:
      'Confirms audio streams directly from approved Quran Foundation CDN URLs and server-side cache entries follow the 7-day limit without rehosting MP3 files.',
    policyVersion: 'QF-7-Day-Cache-Policy',
  },
  {
    key: 'privacyAndTermsReadiness',
    titleEn: 'Privacy Policy & Terms of Use Readiness',
    titleAr: 'جاهزية سياسة الخصوصية وشروط الاستخدام',
    descriptionEn:
      'Confirms public /privacy and /terms disclosures are complete, accessible to families, and meet Quran Foundation Privacy Policy requirements.',
    policyVersion: 'NonoLand-Policy-2026.04',
  },
];

function buildChecklistFromSaved(
  saved?: Record<string, QuranSurahHumanReviewEntry>,
): Record<string, QuranSurahHumanReviewEntry> {
  const out: Record<string, QuranSurahHumanReviewEntry> = {};
  for (const surah of QURAN_SURAHS) {
    const prev = saved?.[surah.id];
    out[surah.id] = {
      surahId: surah.id,
      chapterNumber: surah.number,
      ayahCount: surah.ayahCount,
      reviewedAyahNumbers: Array.isArray(prev?.reviewedAyahNumbers)
        ? prev.reviewedAyahNumbers.filter((n) => n >= 1 && n <= surah.ayahCount)
        : [],
      reviewerName: prev?.reviewerName || '',
      reviewDate: prev?.reviewDate || '',
      reviewResult: prev?.reviewResult || 'pending',
      notes: prev?.notes || '',
    };
  }
  return out;
}

export const QuranReleaseApprovalSection: React.FC<Props> = ({
  apiFetch,
  data,
  qfConfigured,
  qfPreview,
  language,
  onReload,
  onNotice,
  onError,
}) => {
  const husaryRecord = useMemo(
    () => data?.customRecords?.find((r) => r.contentKey === 'adult-husary-muallim'),
    [data],
  );
  const husaryReciter: QuranReciterSpec | undefined = useMemo(
    () => data?.reciters?.find((r) => r.id === 'adult-husary-muallim'),
    [data],
  );
  const readiness = data?.releaseReadiness;
  const basmalaAsset: QuranPhraseAudioAssetConfig | undefined = data?.phraseAssets?.basmala;

  // Read-only QF candidate cache (never mutates DB automatically)
  const [fetchedCandidate, setFetchedCandidate] = useState<InternalTestingCandidatePayload | null>(null);
  const [loadingCandidate, setLoadingCandidate] = useState(false);
  const autoInspectAttemptedRef = useRef(false);

  // Per-action loading states
  const [busyConfKey, setBusyConfKey] = useState<AdminConfirmationKey | ''>('');
  const [savingBasmalaAction, setSavingBasmalaAction] = useState<'approve' | 'reject' | ''>('');
  const [savingSurahId, setSavingSurahId] = useState<string>('');
  const [savingAllTajweed, setSavingAllTajweed] = useState(false);
  const [savingIntegrity, setSavingIntegrity] = useState(false);
  const [savingUrls, setSavingUrls] = useState(false);
  const [releasing, setReleasing] = useState(false);

  // Basmala approval form state (strictly mirrors saved DB state — never pre-checked)
  const [basmalaReviewer, setBasmalaReviewer] = useState('');
  const [basmalaReviewDate, setBasmalaReviewDate] = useState('');
  const [basmalaLicense, setBasmalaLicense] = useState('');
  const [basmalaNotes, setBasmalaNotes] = useState('');
  const [basmalaListeningChecked, setBasmalaListeningChecked] = useState(false);
  const [basmalaTermsChecked, setBasmalaTermsChecked] = useState(false);

  // Tajweed review 9-Surah / 40-Ayah checklist state (strictly mirrors saved DB state)
  const [checklist, setChecklist] = useState<Record<string, QuranSurahHumanReviewEntry>>(() =>
    buildChecklistFromSaved(undefined),
  );

  // Integrity confirmation checkboxes (mirrors saved DB state — never pre-checked)
  const [textIntegrityConfirmed, setTextIntegrityConfirmed] = useState(false);
  const [audioIntegrityConfirmed, setAudioIntegrityConfirmed] = useState(false);
  const [reciterIdentityConfirmed, setReciterIdentityConfirmed] = useState(false);

  // Sync local editor state whenever backend payload reloads
  useEffect(() => {
    if (basmalaAsset) {
      setBasmalaReviewer(basmalaAsset.reviewedBy || '');
      setBasmalaReviewDate(basmalaAsset.reviewedAt || '');
      setBasmalaLicense(
        basmalaAsset.licenseOrPermission ||
          'Quran Foundation Developer Terms (integrated app use, Reciter ID 6 Al-Husary 1:1)',
      );
      setBasmalaNotes(basmalaAsset.notes || '');
      setBasmalaListeningChecked(Boolean(basmalaAsset.humanListeningApproved));
      setBasmalaTermsChecked(Boolean(basmalaAsset.licenseConfirmed));
    }
  }, [basmalaAsset]);

  useEffect(() => {
    setChecklist(buildChecklistFromSaved(husaryRecord?.surahChecklist));
    setTextIntegrityConfirmed(Boolean(husaryRecord?.textIntegrityConfirmed));
    setAudioIntegrityConfirmed(Boolean(husaryRecord?.audioIntegrityConfirmed));
    setReciterIdentityConfirmed(Boolean(husaryRecord?.reciterIdentityConfirmed));
  }, [husaryRecord]);

  const inspectQfCandidate = useCallback(
    async (silentIfMissing = false) => {
      if (!silentIfMissing) onError('');
      setLoadingCandidate(true);
      try {
        const res = await apiFetch('/api/admin/quran/internal-testing-audio');
        const json = (await res.json().catch(() => ({}))) as InternalTestingCandidatePayload;
        if (res.ok) {
          setFetchedCandidate(json);
          if (!silentIfMissing && !json.basmalaCandidateAudioUrl && !json.ayahAudioUrls?.['1:1']) {
            onError(
              json.error ||
                (language === 'ar'
                  ? 'لم يتم العثور على رابط مرشح البسملة (1:1) من Quran Foundation.'
                  : 'Quran Foundation did not return a Reciter ID 6 (1:1) Basmala URL.'),
            );
          }
        } else if (!silentIfMissing) {
          onError(json.error || 'Failed to inspect Quran Foundation Reciter ID 6 audio.');
        }
      } catch {
        if (!silentIfMissing) {
          onError('Network error while inspecting Quran Foundation audio candidate.');
        }
      } finally {
        setLoadingCandidate(false);
      }
    },
    [apiFetch, language, onError],
  );

  // Read-only candidate load on mount if QF is configured and candidate URL isn't cached yet
  useEffect(() => {
    if (
      !autoInspectAttemptedRef.current &&
      data &&
      qfConfigured &&
      !data.basmalaCandidate?.audioUrl &&
      !qfPreview?.ayahAudioUrls?.['1:1']
    ) {
      autoInspectAttemptedRef.current = true;
      void inspectQfCandidate(true);
    }
  }, [data, qfConfigured, qfPreview, inspectQfCandidate]);

  const basmalaCandidateUrl =
    data?.basmalaCandidate?.audioUrl ||
    qfPreview?.ayahAudioUrls?.['1:1'] ||
    fetchedCandidate?.basmalaCandidateAudioUrl ||
    fetchedCandidate?.ayahAudioUrls?.['1:1'] ||
    basmalaAsset?.audioUrl ||
    null;

  const availableQfSurahUrls = useMemo(() => {
    if (qfPreview?.surahAudioUrls && Object.keys(qfPreview.surahAudioUrls).length > 0) {
      return qfPreview.surahAudioUrls;
    }
    if (fetchedCandidate?.surahAudioUrls && Object.keys(fetchedCandidate.surahAudioUrls).length > 0) {
      return fetchedCandidate.surahAudioUrls;
    }
    return null;
  }, [qfPreview, fetchedCandidate]);

  const availableQfAyahUrls = useMemo(() => {
    if (qfPreview?.ayahAudioUrls && Object.keys(qfPreview.ayahAudioUrls).length > 0) {
      return qfPreview.ayahAudioUrls;
    }
    if (fetchedCandidate?.ayahAudioUrls && Object.keys(fetchedCandidate.ayahAudioUrls).length > 0) {
      return fetchedCandidate.ayahAudioUrls;
    }
    return null;
  }, [qfPreview, fetchedCandidate]);

  const localChecklistStats = useMemo(() => {
    let passedSurahs = 0;
    let reviewedAyahs = 0;
    let totalAyahs = 0;
    for (const surah of QURAN_SURAHS) {
      totalAyahs += surah.ayahCount;
      const entry = checklist[surah.id];
      if (!entry) continue;
      reviewedAyahs += entry.reviewedAyahNumbers.length;
      if (
        entry.reviewResult === 'passed' &&
        entry.reviewerName.trim().length > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) &&
        entry.notes.trim().length > 0 &&
        entry.reviewedAyahNumbers.length === surah.ayahCount
      ) {
        passedSurahs += 1;
      }
    }
    return {
      passedSurahs,
      totalSurahs: QURAN_SURAHS.length,
      reviewedAyahs,
      totalAyahs,
    };
  }, [checklist]);

  const handleToggleConfirmation = async (
    key: AdminConfirmationKey,
    nextConfirmed: boolean,
    policyVersion: string,
  ) => {
    onError('');
    setBusyConfKey(key);
    try {
      const res = await apiFetch(`/api/admin/quran/release-confirmations/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: nextConfirmed, policyVersion }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to update administrator confirmation.');
        return;
      }
      onNotice(
        nextConfirmed
          ? `Recorded administrator confirmation: ${key} (${policyVersion}).`
          : `Revoked administrator confirmation: ${key}.`,
      );
      await onReload();
    } finally {
      setBusyConfKey('');
    }
  };

  const handleBasmalaDecision = async (decision: 'approve' | 'reject') => {
    onError('');
    if (decision === 'approve') {
      if (
        !basmalaCandidateUrl ||
        !basmalaReviewer.trim() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(basmalaReviewDate) ||
        !basmalaListeningChecked ||
        !basmalaTermsChecked ||
        !basmalaLicense.trim()
      ) {
        onError(
          language === 'ar'
            ? 'لاعتماد البسملة يجب توفير رابط QF للقارئ ٦، واسم المراجع، وتاريخ المراجعة، وتأكيد الاستماع البشري وشروط الاستخدام.'
            : 'Approving Basmala requires the QF Reciter 6 (1:1) URL, reviewer name, review date (YYYY-MM-DD), license terms, and both confirmation checkboxes.',
        );
        return;
      }
    }

    setSavingBasmalaAction(decision);
    try {
      const res = await apiFetch('/api/admin/quran/phrase-assets/basmala', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioUrl: decision === 'approve' ? basmalaCandidateUrl : basmalaCandidateUrl || '',
          sourceName: 'Quran Foundation Recitation ID 6 (Al-Husary 1:1 Basmala)',
          licenseOrPermission: basmalaLicense.trim(),
          reviewedBy: basmalaReviewer.trim() || undefined,
          reviewedAt: basmalaReviewDate.trim() || undefined,
          licenseConfirmed: decision === 'approve' ? basmalaTermsChecked : false,
          humanListeningApproved: decision === 'approve' ? basmalaListeningChecked : false,
          verificationStatus: decision === 'approve' ? 'verified' : 'unavailable',
          notes:
            basmalaNotes.trim() ||
            (decision === 'reject' ? 'Rejected during admin release review' : undefined),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to update Basmala asset status.');
        return;
      }
      onNotice(
        decision === 'approve'
          ? 'Approved QF Reciter ID 6 Basmala (1:1) asset.'
          : 'Rejected Basmala asset (status set to unavailable). Family access remains blocked.',
      );
      await onReload();
    } finally {
      setSavingBasmalaAction('');
    }
  };

  const updateSurahEntry = (surahId: string, patch: Partial<QuranSurahHumanReviewEntry>) => {
    setChecklist((prev) => {
      const cur = prev[surahId];
      if (!cur) return prev;
      return {
        ...prev,
        [surahId]: {
          ...cur,
          ...patch,
        },
      };
    });
  };

  const toggleSurahAyah = (surahId: string, ayahNum: number) => {
    setChecklist((prev) => {
      const cur = prev[surahId];
      if (!cur) return prev;
      const set = new Set(cur.reviewedAyahNumbers);
      if (set.has(ayahNum)) {
        set.delete(ayahNum);
      } else {
        set.add(ayahNum);
      }
      return {
        ...prev,
        [surahId]: {
          ...cur,
          reviewedAyahNumbers: Array.from(set).sort((a, b) => a - b),
        },
      };
    });
  };

  const handleSaveSingleSurahReview = async (surahId: string) => {
    onError('');
    const entry = checklist[surahId];
    if (!entry) return;
    if (
      entry.reviewResult === 'passed' &&
      (!entry.reviewerName.trim() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) ||
        !entry.notes.trim() ||
        entry.reviewedAyahNumbers.length !== entry.ayahCount)
    ) {
      onError(
        language === 'ar'
          ? 'لتسجيل النتيجة (Pass)، يرجى تحديد جميع آيات السورة وإدخال اسم المراجع والتاريخ والملاحظات.'
          : `To save "${surahId}" as Pass, check all ${entry.ayahCount} Ayahs and fill reviewer name, review date, and notes.`,
      );
      return;
    }
    setSavingSurahId(surahId);
    try {
      const res = await apiFetch('/api/admin/quran/tajweed-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surahReview: {
            surahId: entry.surahId,
            reviewerName: entry.reviewerName.trim(),
            reviewDate: entry.reviewDate.trim(),
            reviewResult: entry.reviewResult,
            reviewedAyahNumbers: entry.reviewedAyahNumbers,
            notes: entry.notes.trim(),
          },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to save Surah Tajweed review.');
        return;
      }
      onNotice(`Saved human Tajweed review for ${surahId} (${entry.reviewResult}).`);
      await onReload();
    } finally {
      setSavingSurahId('');
    }
  };

  const handleSaveAllTajweedReviews = async () => {
    onError('');
    setSavingAllTajweed(true);
    try {
      const res = await apiFetch('/api/admin/quran/tajweed-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surahChecklist: checklist,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to save Tajweed checklist.');
        return;
      }
      onNotice('Saved 9-Surah / 40-Ayah human Tajweed review records.');
      await onReload();
    } finally {
      setSavingAllTajweed(false);
    }
  };

  const handleSaveIntegrityChecks = async () => {
    onError('');
    setSavingIntegrity(true);
    try {
      const res = await apiFetch('/api/admin/quran/tajweed-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textIntegrityConfirmed,
          audioIntegrityConfirmed,
          reciterIdentityConfirmed,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to save integrity confirmation flags.');
        return;
      }
      onNotice('Saved technical integrity & Reciter ID 6 identity checks.');
      await onReload();
    } finally {
      setSavingIntegrity(false);
    }
  };

  const handleSaveQfUrlsToDraft = async () => {
    if (!availableQfSurahUrls || !availableQfAyahUrls) return;
    onError('');
    setSavingUrls(true);
    try {
      const res = await apiFetch('/api/admin/quran/tajweed-review', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioUrlsJson: availableQfSurahUrls,
          ayahAudioUrlsJson: availableQfAyahUrls,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to save verified QF Reciter 6 URLs.');
        return;
      }
      onNotice('Saved verified Quran Foundation Reciter ID 6 Surah & Ayah URLs into review draft.');
      await onReload();
    } finally {
      setSavingUrls(false);
    }
  };

  const handleFinalReleaseDecision = async (targetStatus: 'verified' | 'pending_verification') => {
    onError('');
    setReleasing(true);
    try {
      const res = await apiFetch('/api/admin/quran/verifications/adult-husary-muallim', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationStatus: targetStatus,
          sourceName:
            husaryRecord?.sourceName ||
            husaryReciter?.sourceName ||
            'Quran Foundation Content API v4 (Production)',
          licenseOrPermission:
            husaryRecord?.licenseOrPermission ||
            husaryReciter?.licenseOrPermission ||
            'Quran Foundation Developer Terms (integrated app use, direct streaming)',
          tajweedReviewedBy:
            husaryRecord?.tajweedReviewedBy ||
            Object.values(checklist)
              .map((s) => s.reviewerName.trim())
              .find(Boolean) ||
            '',
          tajweedReviewedAt:
            husaryRecord?.tajweedReviewedAt ||
            Object.values(checklist)
              .map((s) => s.reviewDate.trim())
              .find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) ||
            undefined,
          textIntegrityConfirmed,
          audioIntegrityConfirmed,
          reciterIdentityConfirmed,
          surahChecklist: checklist,
          audioUrlsJson: husaryRecord?.audioUrlsJson || availableQfSurahUrls || {},
          ayahAudioUrlsJson: husaryRecord?.ayahAudioUrlsJson || availableQfAyahUrls || {},
          notes: husaryRecord?.notes || '',
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(json.error || 'Failed to update Quran World family release status.');
        return;
      }
      onNotice(
        targetStatus === 'verified'
          ? 'Quran World approved for families. Verified Reciter ID 6 audio is now live.'
          : 'Paused family release — Quran World reverted to pending verification.',
      );
      await onReload();
    } finally {
      setReleasing(false);
    }
  };

  const confirmations: QuranAdminConfirmations | undefined = readiness?.confirmations;
  const basmalaStatusLabel =
    readiness?.basmalaApproved
      ? 'Completed'
      : basmalaAsset?.verificationStatus === 'unavailable'
        ? 'Rejected (Unavailable)'
        : 'Pending';

  return (
    <section
      aria-labelledby="quran-release-approval-heading"
      className="rounded-3xl border border-[#27345C]/15 bg-white p-5 sm:p-6 space-y-6 text-xs text-[#27345C]"
    >
      {/* Header + Release State */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#27345C]/10 pb-4">
        <div>
          <h3
            id="quran-release-approval-heading"
            className="text-lg sm:text-xl font-extrabold text-[#27345C] flex items-center gap-2"
          >
            <ShieldCheck className="w-5 h-5 text-[#047857]" />
            <span>Quran World – Release Approval</span>
          </h3>
          <p className="text-[#27345C]/75 font-bold mt-1">
            {language === 'ar'
              ? 'مسار الاعتماد الإداري والبشري لإطلاق عالم القرآن للعائلات. لا تُمنح أي موافقة تلقائياً.'
              : 'Administrator compliance confirmations, human Tajweed review, Basmala asset approval, and final family release gate. Fail-closed by default.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loadingCandidate}
            onClick={() => void inspectQfCandidate(false)}
            className="min-h-[38px] px-3.5 rounded-xl border border-[#27345C]/20 bg-[#F8FAFC] text-[#27345C] font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingCandidate ? 'animate-spin' : ''}`} />
            <span>
              {loadingCandidate ? 'Inspecting QF...' : 'Inspect QF Reciter 6 Candidate'}
            </span>
          </button>

          <span
            dir="ltr"
            className={`px-3 py-1.5 rounded-xl font-mono-num font-extrabold text-xs ${
              readiness?.familyAccessEnabled
                ? 'bg-[#047857] text-white'
                : 'bg-[#92400E] text-white'
            }`}
          >
            Family Release: {readiness?.familyAccessEnabled ? 'Approved' : 'Blocked'}
          </span>
        </div>
      </div>

      {/* Release Status Dashboard */}
      {readiness && (
        <div className="space-y-3" dir="ltr">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="p-3.5 rounded-2xl border border-[#27345C]/12 bg-[#F8FAFC] space-y-1">
              <p className="text-[11px] font-bold text-[#27345C]/70">Administrator Confirmations</p>
              <p
                className={`text-sm font-extrabold font-mono-num tabular-nums ${
                  readiness.allAdminConfirmationsComplete ? 'text-[#047857]' : 'text-[#92400E]'
                }`}
              >
                {readiness.allAdminConfirmationsComplete ? 'Completed' : 'Pending'} (
                {readiness.adminConfirmationsCount}/{readiness.adminConfirmationsTotal})
              </p>
            </div>

            <div className="p-3.5 rounded-2xl border border-[#27345C]/12 bg-[#F8FAFC] space-y-1">
              <p className="text-[11px] font-bold text-[#27345C]/70">Tajweed Review (9 / 40)</p>
              <p
                className={`text-sm font-extrabold font-mono-num tabular-nums ${
                  readiness.tajweedReviewComplete ? 'text-[#047857]' : 'text-[#92400E]'
                }`}
              >
                {readiness.tajweedReviewComplete ? 'Completed' : 'Pending'} (
                {readiness.surahsPassedCount}/{readiness.surahsTotalCount} ·{' '}
                {readiness.ayahsReviewedCount}/{readiness.ayahsTotalCount})
              </p>
            </div>

            <div className="p-3.5 rounded-2xl border border-[#27345C]/12 bg-[#F8FAFC] space-y-1">
              <p className="text-[11px] font-bold text-[#27345C]/70">Basmala Approval</p>
              <p
                className={`text-sm font-extrabold font-mono-num ${
                  readiness.basmalaApproved
                    ? 'text-[#047857]'
                    : basmalaAsset?.verificationStatus === 'unavailable'
                      ? 'text-[#B91C1C]'
                      : 'text-[#92400E]'
                }`}
              >
                {basmalaStatusLabel}
              </p>
            </div>

            <div className="p-3.5 rounded-2xl border border-[#27345C]/12 bg-[#F8FAFC] space-y-1">
              <p className="text-[11px] font-bold text-[#27345C]/70">
                Closing Phrase (صَدَقَ اللَّهُ الْعَظِيمُ)
              </p>
              <p className="text-sm font-extrabold text-[#27345C]">Disabled / Not required</p>
            </div>

            <div
              className={`p-3.5 rounded-2xl border space-y-1 ${
                readiness.familyAccessEnabled
                  ? 'border-[#047857]/30 bg-[#ECFDF5]'
                  : 'border-[#D97706]/30 bg-[#FFFBEB]'
              }`}
            >
              <p className="text-[11px] font-bold text-[#27345C]/70">Family Release</p>
              <p
                className={`text-sm font-extrabold font-mono-num ${
                  readiness.familyAccessEnabled ? 'text-[#047857]' : 'text-[#92400E]'
                }`}
              >
                {readiness.familyAccessEnabled ? 'Approved' : 'Blocked'}
              </p>
            </div>
          </div>

          {!readiness.familyAccessEnabled && readiness.pendingApprovals.length > 0 && (
            <div className="p-4 rounded-2xl border border-[#D97706]/30 bg-[#FFFBEB] space-y-2">
              <p className="font-extrabold text-[#92400E] flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>
                  Blocking Reasons ({readiness.pendingApprovals.length}): Family accounts cannot access recitation audio until resolved
                </span>
              </p>
              <ul className="list-disc ps-5 space-y-1 text-[#92400E] font-bold">
                {readiness.pendingApprovals.map((blocker) => (
                  <li key={blocker.key}>{language === 'ar' ? blocker.labelAr : blocker.labelEn}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* 1. Administrator Confirmations */}
      <div className="space-y-3 border-t border-[#27345C]/10 pt-5" dir="ltr">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-base font-extrabold text-[#27345C]">
              1. Administrator Confirmations ({readiness?.adminConfirmationsCount ?? 0}/4)
            </h4>
            <p className="text-[#27345C]/70 font-bold">
              Confirm or revoke each compliance requirement individually. Every confirmation records admin identity, timestamp, and policy version.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CONFIRMATION_ITEMS.map((item) => {
            const saved = confirmations?.[item.key];
            const isConfirmed = Boolean(saved?.confirmed);
            const isBusy = busyConfKey === item.key;

            return (
              <div
                key={item.key}
                className={`p-4 rounded-2xl border space-y-2.5 flex flex-col justify-between ${
                  isConfirmed
                    ? 'border-[#047857]/30 bg-[#ECFDF5]/60'
                    : 'border-[#27345C]/15 bg-[#F8FAFC]'
                }`}
              >
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-extrabold text-sm text-[#27345C]">
                      {language === 'ar' ? item.titleAr : item.titleEn}
                    </p>
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded font-mono-num text-[11px] font-extrabold ${
                        isConfirmed
                          ? 'bg-[#DCFCE7] text-[#166534]'
                          : 'bg-[#FEF3C7] text-[#92400E]'
                      }`}
                    >
                      {isConfirmed ? 'Completed' : 'Pending'}
                    </span>
                  </div>
                  <p className="text-[#27345C]/75 font-semibold leading-relaxed">
                    {item.descriptionEn}
                  </p>
                  <div className="font-mono-num tabular-nums text-[11px] text-[#27345C]/75 space-y-0.5 pt-1">
                    <p>
                      Policy version: <strong>{saved?.policyVersion || item.policyVersion}</strong>
                    </p>
                    {isConfirmed ? (
                      <p className="text-[#065F46]">
                        Confirmed by <strong>{saved?.confirmedBy || 'admin'}</strong>{' '}
                        {saved?.confirmedByUserId ? `(${saved.confirmedByUserId})` : ''} @{' '}
                        {saved?.confirmedAt || 'recorded'}
                      </p>
                    ) : (
                      <p className="text-[#92400E]">Not yet confirmed by an administrator.</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-end pt-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void handleToggleConfirmation(item.key, !isConfirmed, item.policyVersion)
                    }
                    className={`min-h-[36px] px-4 rounded-xl font-extrabold cursor-pointer disabled:opacity-50 ${
                      isConfirmed
                        ? 'border border-[#27345C]/25 bg-white text-[#27345C] hover:bg-[#FEF2F2] hover:text-[#991B1B]'
                        : 'bg-[#047857] text-white hover:bg-[#065F46]'
                    }`}
                  >
                    {isBusy
                      ? 'Saving...'
                      : isConfirmed
                        ? 'Revoke Confirmation'
                        : 'Confirm Requirement'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Basmala Asset Approval (QF Reciter ID 6 1:1 Candidate) */}
      <div className="space-y-3 border-t border-[#27345C]/10 pt-5" dir="ltr">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-base font-extrabold text-[#27345C]">
              2. Basmala Asset Approval (QF Reciter ID 6 — 1:1 Candidate)
            </h4>
            <p className="text-[#27345C]/70 font-bold">
              Al-Fatihah preserves its 1:1 verse recitation (never duplicated). The other 8 curated Surahs require this approved Basmala asset. Closing phrase "صَدَقَ اللَّهُ الْعَظِيمُ" stays disabled and is not required.
            </p>
          </div>
          <span
            className={`px-2.5 py-1 rounded-lg font-mono-num font-extrabold ${
              readiness?.basmalaApproved
                ? 'bg-[#DCFCE7] text-[#166534]'
                : basmalaAsset?.verificationStatus === 'unavailable'
                  ? 'bg-[#FEE2E2] text-[#991B1B]'
                  : 'bg-[#FEF3C7] text-[#92400E]'
            }`}
          >
            Status: {basmalaStatusLabel}
          </span>
        </div>

        <div className="p-4 rounded-2xl border border-[#27345C]/15 bg-[#F8FAFC] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-extrabold text-[#27345C] flex items-center gap-1.5">
                <Volume2 className="w-4 h-4 text-[#047857]" />
                <span>QF Reciter ID 6 Candidate (Al-Husary · 1:1)</span>
              </p>
              <p className="font-mono-num text-[11px] text-[#27345C]/75 break-all">
                {basmalaCandidateUrl || 'Candidate URL not loaded yet — click "Inspect QF Reciter 6 Candidate" above.'}
              </p>
            </div>
            {basmalaCandidateUrl && (
              <audio
                controls
                preload="none"
                src={basmalaCandidateUrl}
                className="h-9 max-w-full"
              />
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-bold">
            <label className="space-y-1">
              <span>Human Listening Reviewer Full Name *</span>
              <input
                type="text"
                value={basmalaReviewer}
                onChange={(e) => setBasmalaReviewer(e.target.value)}
                placeholder="Authorized reviewer name"
                className="w-full h-9 px-3 rounded-xl bg-white border border-[#27345C]/20"
              />
            </label>
            <label className="space-y-1">
              <span>Review Date *</span>
              <input
                type="date"
                value={basmalaReviewDate}
                onChange={(e) => setBasmalaReviewDate(e.target.value)}
                className="w-full h-9 px-3 rounded-xl bg-white border border-[#27345C]/20 font-mono-num"
              />
            </label>
            <label className="space-y-1">
              <span>Notes</span>
              <input
                type="text"
                value={basmalaNotes}
                onChange={(e) => setBasmalaNotes(e.target.value)}
                placeholder="Recitation quality & listening verification notes"
                className="w-full h-9 px-3 rounded-xl bg-white border border-[#27345C]/20"
              />
            </label>
          </div>

          <label className="block space-y-1 font-bold">
            <span>Applicable Usage Terms / License Reference *</span>
            <input
              type="text"
              value={basmalaLicense}
              onChange={(e) => setBasmalaLicense(e.target.value)}
              className="w-full h-9 px-3 rounded-xl bg-white border border-[#27345C]/20"
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3 rounded-xl bg-white border border-[#27345C]/12 font-bold">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={basmalaListeningChecked}
                onChange={(e) => setBasmalaListeningChecked(e.target.checked)}
                className="mt-0.5"
              />
              <span>Human listening review completed (verified Reciter ID 6 Basmala audio)</span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={basmalaTermsChecked}
                onChange={(e) => setBasmalaTermsChecked(e.target.checked)}
                className="mt-0.5"
              />
              <span>Covered by applicable Quran Foundation usage terms</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={savingBasmalaAction !== ''}
              onClick={() => void handleBasmalaDecision('reject')}
              className="min-h-[38px] px-4 rounded-xl border border-[#DC2626]/35 bg-white text-[#991B1B] font-extrabold cursor-pointer hover:bg-[#FEF2F2] disabled:opacity-50"
            >
              {savingBasmalaAction === 'reject' ? 'Rejecting...' : 'Reject Basmala Asset'}
            </button>
            <button
              type="button"
              disabled={savingBasmalaAction !== '' || !basmalaCandidateUrl}
              onClick={() => void handleBasmalaDecision('approve')}
              className="min-h-[38px] px-4 rounded-xl bg-[#047857] text-white font-extrabold cursor-pointer hover:bg-[#065F46] disabled:opacity-50"
            >
              {savingBasmalaAction === 'approve' ? 'Approving...' : 'Approve Basmala Asset'}
            </button>
          </div>
        </div>
      </div>

      {/* 3. Human Tajweed Review (All 9 Curated Surahs & 40 Ayahs) */}
      <div className="space-y-3 border-t border-[#27345C]/10 pt-5" dir="ltr">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-base font-extrabold text-[#27345C]">
              3. Human Tajweed Review (9 Curated Surahs · 40 Ayahs)
            </h4>
            <p className="text-[#27345C]/70 font-bold">
              Record reviewer full name, review date, reviewed Ayahs, Pass / Needs correction result, and notes for every curated Surah.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1 rounded-lg bg-[#F8FAFC] border border-[#27345C]/15 font-mono-num tabular-nums font-extrabold">
              Saved: {readiness?.surahsPassedCount ?? 0}/9 Surahs · {readiness?.ayahsReviewedCount ?? 0}/40 Ayahs
              {' · '}Draft: {localChecklistStats.passedSurahs}/9 · {localChecklistStats.reviewedAyahs}/40
            </span>
            <button
              type="button"
              disabled={savingAllTajweed}
              onClick={() => void handleSaveAllTajweedReviews()}
              className="min-h-[36px] px-4 rounded-xl bg-[#27345C] text-white font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{savingAllTajweed ? 'Saving All...' : 'Save All Tajweed Reviews'}</span>
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          {QURAN_SURAHS.map((surah) => {
            const entry = checklist[surah.id] || {
              surahId: surah.id,
              chapterNumber: surah.number,
              ayahCount: surah.ayahCount,
              reviewedAyahNumbers: [],
              reviewerName: '',
              reviewDate: '',
              reviewResult: 'pending' as QuranSurahReviewResult,
              notes: '',
            };
            const isComplete =
              entry.reviewResult === 'passed' &&
              entry.reviewerName.trim().length > 0 &&
              /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) &&
              entry.notes.trim().length > 0 &&
              entry.reviewedAyahNumbers.length === surah.ayahCount;

            return (
              <div
                key={surah.id}
                className={`p-3.5 rounded-2xl border space-y-2.5 ${
                  isComplete
                    ? 'border-[#047857]/30 bg-[#ECFDF5]/40'
                    : entry.reviewResult === 'issues_found'
                      ? 'border-[#DC2626]/30 bg-[#FEF2F2]/40'
                      : 'border-[#27345C]/12 bg-[#F8FAFC]'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-extrabold text-sm text-[#27345C]">
                      {surah.number}. {surah.nameEn} ({surah.nameAr})
                    </span>
                    <span className="font-mono-num text-[11px] text-[#27345C]/70">
                      {surah.number === 1
                        ? 'Basmala in 1:1 (no duplicate)'
                        : 'Requires approved Basmala'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono-num tabular-nums text-[11px] font-bold text-[#27345C]/75">
                      {entry.reviewedAyahNumbers.length}/{surah.ayahCount} Ayahs
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const allChecked = entry.reviewedAyahNumbers.length === surah.ayahCount;
                        updateSurahEntry(surah.id, {
                          reviewedAyahNumbers: allChecked ? [] : surah.ayahs.map((a) => a.number),
                        });
                      }}
                      className="px-2.5 py-1 rounded-lg bg-white border border-[#27345C]/20 text-[11px] font-bold cursor-pointer hover:bg-[#F1F5F9]"
                    >
                      {entry.reviewedAyahNumbers.length === surah.ayahCount
                        ? 'Clear Ayahs'
                        : `Select all ${surah.ayahCount} Ayahs`}
                    </button>
                    <button
                      type="button"
                      disabled={savingSurahId === surah.id}
                      onClick={() => void handleSaveSingleSurahReview(surah.id)}
                      className="px-3 py-1 rounded-lg bg-[#047857] text-white text-[11px] font-extrabold cursor-pointer disabled:opacity-50"
                    >
                      {savingSurahId === surah.id ? 'Saving...' : 'Save Review'}
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {surah.ayahs.map((ayah) => {
                    const checked = entry.reviewedAyahNumbers.includes(ayah.number);
                    return (
                      <button
                        key={ayah.verseKey}
                        type="button"
                        onClick={() => toggleSurahAyah(surah.id, ayah.number)}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono-num border cursor-pointer ${
                          checked
                            ? 'bg-[#047857] text-white border-[#047857]'
                            : 'bg-white text-[#27345C] border-[#27345C]/20'
                        }`}
                      >
                        {checked ? '✓ ' : ''}
                        {ayah.verseKey}
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 font-bold">
                  <input
                    type="text"
                    value={entry.reviewerName}
                    onChange={(e) => updateSurahEntry(surah.id, { reviewerName: e.target.value })}
                    placeholder="Reviewer full name *"
                    aria-label={`${surah.nameEn} reviewer full name`}
                    className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/20"
                  />
                  <input
                    type="date"
                    value={entry.reviewDate}
                    onChange={(e) => updateSurahEntry(surah.id, { reviewDate: e.target.value })}
                    aria-label={`${surah.nameEn} review date`}
                    className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/20 font-mono-num"
                  />
                  <select
                    value={entry.reviewResult}
                    onChange={(e) =>
                      updateSurahEntry(surah.id, {
                        reviewResult: e.target.value as QuranSurahReviewResult,
                      })
                    }
                    aria-label={`${surah.nameEn} review result`}
                    className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/20"
                  >
                    <option value="pending">Pending</option>
                    <option value="passed">Pass</option>
                    <option value="issues_found">Needs correction</option>
                  </select>
                  <input
                    type="text"
                    value={entry.notes}
                    onChange={(e) => updateSurahEntry(surah.id, { notes: e.target.value })}
                    placeholder="Tajweed & recitation notes *"
                    aria-label={`${surah.nameEn} review notes`}
                    className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/20"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Integrity Verification & Final Family Release Action */}
      <div className="space-y-4 border-t border-[#27345C]/10 pt-5" dir="ltr">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-base font-extrabold text-[#27345C]">
              4. Integrity Verification &amp; Final Family Release
            </h4>
            <p className="text-[#27345C]/70 font-bold">
              Reciter ID 6 audio coverage ({readiness?.surahAudioUrlsCount ?? 0}/9 Surahs ·{' '}
              {readiness?.ayahAudioUrlsCount ?? 0}/40 Ayahs), text SHA-256 verification, attribution/privacy readiness, and final release authorization.
            </p>
          </div>
          {availableQfSurahUrls &&
            availableQfAyahUrls &&
            ((readiness?.surahAudioUrlsCount ?? 0) < 9 || (readiness?.ayahAudioUrlsCount ?? 0) < 40) && (
              <button
                type="button"
                disabled={savingUrls}
                onClick={() => void handleSaveQfUrlsToDraft()}
                className="min-h-[36px] px-3.5 rounded-xl border border-[#047857]/35 bg-[#ECFDF5] text-[#065F46] font-extrabold cursor-pointer disabled:opacity-50"
              >
                {savingUrls
                  ? 'Saving URLs...'
                  : 'Save Verified QF Reciter 6 Audio URLs to Draft'}
              </button>
            )}
        </div>

        <div className="p-4 rounded-2xl border border-[#27345C]/15 bg-[#F8FAFC] space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 font-bold">
            <label className="flex items-start gap-2 p-2.5 rounded-xl bg-white border border-[#27345C]/12 cursor-pointer">
              <input
                type="checkbox"
                checked={textIntegrityConfirmed}
                onChange={(e) => setTextIntegrityConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>Text Integrity (9 Surahs / 40 Ayahs SHA-256 matched)</span>
            </label>
            <label className="flex items-start gap-2 p-2.5 rounded-xl bg-white border border-[#27345C]/12 cursor-pointer">
              <input
                type="checkbox"
                checked={audioIntegrityConfirmed}
                onChange={(e) => setAudioIntegrityConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>Audio Integrity (49 HTTPS URLs valid &amp; playable)</span>
            </label>
            <label className="flex items-start gap-2 p-2.5 rounded-xl bg-white border border-[#27345C]/12 cursor-pointer">
              <input
                type="checkbox"
                checked={reciterIdentityConfirmed}
                onChange={(e) => setReciterIdentityConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>Reciter Identity (ID 6 = Mahmoud Khaleel Al-Husary, Murattal / Hafs)</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-[11px] font-bold text-[#27345C]/75">
              Attribution ready: "Quran data provided by Quran.Foundation." · Direct QF streaming · Closing phrase disabled
            </p>
            <button
              type="button"
              disabled={savingIntegrity}
              onClick={() => void handleSaveIntegrityChecks()}
              className="min-h-[36px] px-4 rounded-xl border border-[#27345C]/20 bg-white text-[#27345C] font-extrabold cursor-pointer disabled:opacity-50"
            >
              {savingIntegrity ? 'Saving Checks...' : 'Save Integrity Checks'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl border border-[#27345C]/15 bg-white">
          <div className="space-y-0.5">
            <p className="font-extrabold text-sm text-[#27345C]">
              {readiness?.familyAccessEnabled
                ? 'Quran World is currently Approved and Live for Families'
                : readiness?.canApproveFamilyRelease
                  ? 'All release gates passed — Ready to Approve Quran World for Families'
                  : 'Final release locked until all confirmations, 9/9 Surahs, Basmala, and integrity checks pass'}
            </p>
            <p className="font-mono-num text-[11px] text-[#27345C]/70">
              Reciter record: adult-husary-muallim ({readiness?.reciterStatus || 'pending_verification'})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {readiness?.familyAccessEnabled ? (
              <button
                type="button"
                disabled={releasing}
                onClick={() => void handleFinalReleaseDecision('pending_verification')}
                className="min-h-[42px] px-5 rounded-xl border border-[#92400E]/35 bg-[#FFFBEB] text-[#92400E] font-extrabold cursor-pointer disabled:opacity-50"
              >
                {releasing ? 'Updating...' : 'Pause Family Release'}
              </button>
            ) : (
              <button
                type="button"
                disabled={releasing || !readiness?.canApproveFamilyRelease}
                onClick={() => void handleFinalReleaseDecision('verified')}
                className="min-h-[42px] px-5 rounded-xl bg-[#047857] text-white font-extrabold flex items-center gap-2 cursor-pointer hover:bg-[#065F46] disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  {releasing ? 'Approving...' : 'Approve Quran World for Families'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
