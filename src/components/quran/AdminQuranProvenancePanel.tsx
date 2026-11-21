import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BookOpen, Check, CheckCircle2, Copy, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useNonoLand } from '../../context/NonoLandContext';
import { QURAN_SURAHS } from '../../data/quranCatalog';
import type {
  QuranAdminConfirmations,
  QuranPhraseAudioAssetConfig,
  QuranReciterSpec,
  QuranSurahHumanReviewEntry,
  QuranSurahReviewResult,
  QuranVerificationStatus,
} from '../../types/nonoland';
import type { AdminQuranVerificationsPayload } from './QuranSharedTypes';
import { AdminQuranTestingPlayer } from './AdminQuranTestingPlayer';
import { QuranReleaseApprovalSection } from './QuranReleaseApprovalSection';
import {
  extractHtmlTitle,
  formatSafeDiagnosticsCopyText,
  isHtmlPayload,
  normalizeQfPreviewResponse,
  redactSensitiveText,
  summarizeEndpointStatuses,
  type QfPreviewState,
} from './qfDiagnosticsHelpers';

interface Props {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

interface AudioStatusPayload {
  provider: string;
  quranFoundationConfigured: boolean;
  attributionRequired: boolean;
  singleDefaultReciter: {
    id: string;
    canonicalSlug: string;
    nameAr: string;
    nameEn: string;
    verificationStatus: QuranVerificationStatus;
    verifiedSurahCount: number;
    verifiedAyahCount: number;
    attribution: { ar: string; en: string };
  };
}

export const AdminQuranProvenancePanel: React.FC<Props> = ({
  apiFetch,
  onNotice,
  onError,
}) => {
  const { language } = useNonoLand();
  const [data, setData] = useState<AdminQuranVerificationsPayload | null>(null);
  const [qfStatus, setQfStatus] = useState<AudioStatusPayload | null>(null);
  const [qfPreview, setQfPreview] = useState<QfPreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  const [editingKey, setEditingKey] = useState<string>('');
  const [statusDraft, setStatusDraft] = useState<QuranVerificationStatus>('pending_verification');
  const [sourceDraft, setSourceDraft] = useState('');
  const [licenseDraft, setLicenseDraft] = useState('');
  const [reviewerDraft, setReviewerDraft] = useState('');
  const [audioUrlsText, setAudioUrlsText] = useState('');
  const [ayahUrlsText, setAyahUrlsText] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [textIntegrityConfirmed, setTextIntegrityConfirmed] = useState(false);
  const [audioIntegrityConfirmed, setAudioIntegrityConfirmed] = useState(false);
  const [reciterIdentityConfirmed, setReciterIdentityConfirmed] = useState(false);
  const [surahChecklistDraft, setSurahChecklistDraft] = useState<
    Record<string, QuranSurahHumanReviewEntry>
  >({});
  const [adminConfDraft, setAdminConfDraft] = useState<QuranAdminConfirmations>({
    qfDeveloperTermsAndCommercialUse: { confirmed: false },
    qfAttributionAndReciterCredit: { confirmed: false },
    qfAttributionAndTerms: { confirmed: false },
    sevenDayCachePolicy: { confirmed: false },
    privacyAndTermsReadiness: { confirmed: false },
    humanTajweedApproval: { confirmed: false },
    basmalaAudioApproval: { confirmed: false },
  });
  const [saving, setSaving] = useState(false);

  // Separate admin editor state for Opening Basmala & Closing Phrase ("صَدَقَ اللَّهُ الْعَظِيمُ")
  const [editingPhraseKey, setEditingPhraseKey] = useState<'basmala' | 'closing' | ''>('');
  const [phraseUrlDraft, setPhraseUrlDraft] = useState('');
  const [phraseSourceDraft, setPhraseSourceDraft] = useState('');
  const [phraseLicenseDraft, setPhraseLicenseDraft] = useState('');
  const [phraseReviewerDraft, setPhraseReviewerDraft] = useState('');
  const [phraseReviewedAtDraft, setPhraseReviewedAtDraft] = useState('');
  const [phraseNotesDraft, setPhraseNotesDraft] = useState('');
  const [phraseLicenseConfirmed, setPhraseLicenseConfirmed] = useState(false);
  const [phraseHumanApproved, setPhraseHumanApproved] = useState(false);
  const [phraseStatusDraft, setPhraseStatusDraft] = useState<QuranVerificationStatus>('pending_verification');
  const [savingPhrase, setSavingPhrase] = useState(false);
  const [loadingBasmalaCandidate, setLoadingBasmalaCandidate] = useState(false);

  const loadVerifications = useCallback(async () => {
    const [verRes, statusRes] = await Promise.all([
      apiFetch('/api/admin/quran/verifications'),
      apiFetch('/api/quran/audio/status'),
    ]);
    if (verRes.ok) {
      setData((await verRes.json()) as AdminQuranVerificationsPayload);
    }
    if (statusRes.ok) {
      setQfStatus((await statusRes.json()) as AudioStatusPayload);
    }
  }, [apiFetch]);

  useEffect(() => {
    void loadVerifications();
  }, [loadVerifications]);

  const handleCopyDiagnostics = async () => {
    if (!qfPreview) return;
    const text = formatSafeDiagnosticsCopyText(qfPreview);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        el.setAttribute('readonly', 'true');
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedDiag(true);
      setTimeout(() => setCopiedDiag(false), 2000);
    } catch {
      onError(language === 'ar' ? 'تعذّر نسخ تفاصيل التشخيص.' : 'Unable to copy diagnostics.');
    }
  };

  const ensureExpressBackendReady = async (): Promise<{
    ready: boolean;
    htmlDetected: boolean;
    httpStatus: number;
    contentType: string;
    expressHeaderPresent: boolean;
    rawText: string;
  }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const healthRes = await apiFetch('/api/health', {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const contentType = healthRes.headers.get('content-type') || 'unknown';
      const expressHeaderPresent = healthRes.headers.get('x-nonoland-api') === 'express';
      const rawText = await healthRes.text();
      const htmlDetected = isHtmlPayload(contentType, rawText);

      if (!htmlDetected && /application\/json/i.test(contentType)) {
        let parsedHealth: { serverReady?: boolean; status?: string } | null = null;
        try {
          parsedHealth = JSON.parse(rawText) as { serverReady?: boolean; status?: string };
        } catch {
          parsedHealth = null;
        }
        if (parsedHealth && parsedHealth.serverReady !== false) {
          return {
            ready: true,
            htmlDetected: false,
            httpStatus: healthRes.status,
            contentType,
            expressHeaderPresent,
            rawText,
          };
        }
      }

      if (attempt < 2 && (htmlDetected || healthRes.status === 503)) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      return {
        ready: false,
        htmlDetected,
        httpStatus: healthRes.status,
        contentType,
        expressHeaderPresent,
        rawText,
      };
    }

    return {
      ready: false,
      htmlDetected: false,
      httpStatus: 0,
      contentType: 'unknown',
      expressHeaderPresent: false,
      rawText: '',
    };
  };

  const handleRunQfPreview = async () => {
    onError('');
    setCopiedDiag(false);
    setPreviewLoading(true);
    try {
      const healthCheck = await ensureExpressBackendReady();
      if (!healthCheck.ready && healthCheck.htmlDetected) {
        const htmlTitle = extractHtmlTitle(healthCheck.rawText);
        const msg = 'Backend routing/startup error: HTML received instead of API JSON';
        setQfPreview({
          requestPath: 'GET /api/health -> POST /api/admin/quran/qf-sync-preview (blocked pre-flight)',
          httpStatus: healthCheck.httpStatus,
          resOk: false,
          ok: false,
          configured: Boolean(qfStatus?.quranFoundationConfigured),
          attributionRequired: true,
          surahAudioUrls: {},
          ayahAudioUrls: {},
          validHttpsSurahCount: 0,
          validHttpsAyahCount: 0,
          validHttpsTotalCount: 0,
          reciterId: null,
          verificationStatus: 'pending_verification',
          diagnostics: null,
          validation: null,
          failureStage: 'BACKEND_ROUTING_OR_STARTUP_HTML',
          safeResponseSummary: {
            contentType: healthCheck.contentType,
            expressHeaderPresent: healthCheck.expressHeaderPresent,
            ...(htmlTitle ? { htmlTitle } : {}),
            topLevelKeys: [],
            safeTextSnippet: redactSensitiveText(healthCheck.rawText, 240),
          },
          error: msg,
        });
        onError(msg);
        return;
      }

      const res = await apiFetch('/api/admin/quran/qf-sync-preview', {
        method: 'POST',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const rawText = await res.text();
      const normalized = normalizeQfPreviewResponse({
        requestPath: 'POST /api/admin/quran/qf-sync-preview',
        httpStatus: res.status,
        resOk: res.ok,
        contentType: res.headers.get('content-type') || 'unknown',
        expressHeaderPresent: res.headers.get('x-nonoland-api') === 'express',
        rawText,
      });
      setQfPreview(normalized);

      if (!normalized.ok) {
        onError(
          normalized.error === 'QF_CREDENTIALS_NOT_CONFIGURED'
            ? language === 'ar'
              ? 'مفاتيح QF_CLIENT_ID وQF_CLIENT_SECRET غير مضافة في Secrets على الخادم بعد.'
              : 'QF_CLIENT_ID and QF_CLIENT_SECRET are not configured in server Secrets yet.'
            : normalized.error ||
              (language === 'ar'
                ? 'فشلت معاينة Quran Foundation: لم يتم جلب أي روابط صوتية.'
                : 'Quran Foundation preview failed: no recitation audio URLs were returned.'),
        );
      } else {
        onNotice(
          language === 'ar'
            ? 'تم جلب معاينة روابط التلاوة من Quran Foundation (لا تزال بانتظار المراجعة والترخيص).'
            : 'Loaded recitation preview from Quran Foundation (still pending license & Tajweed review).',
        );
      }
    } catch (err) {
      const safeErrMsg = err instanceof Error ? redactSensitiveText(err.message, 180) : 'Network failure';
      setQfPreview({
        requestPath: 'POST /api/admin/quran/qf-sync-preview',
        httpStatus: 0,
        resOk: false,
        ok: false,
        configured: Boolean(qfStatus?.quranFoundationConfigured),
        attributionRequired: true,
        surahAudioUrls: {},
        ayahAudioUrls: {},
        validHttpsSurahCount: 0,
        validHttpsAyahCount: 0,
        validHttpsTotalCount: 0,
        reciterId: null,
        verificationStatus: 'pending_verification',
        diagnostics: null,
        validation: null,
        failureStage: 'NETWORK_ERROR',
        safeResponseSummary: {
          contentType: 'none',
          expressHeaderPresent: false,
          topLevelKeys: [],
          safeTextSnippet: safeErrMsg,
        },
        error: safeErrMsg,
      });
      onError(
        language === 'ar'
          ? `تعذّر الاتصال بالخادم أثناء معاينة Quran Foundation (${safeErrMsg}).`
          : `Network error while requesting Quran Foundation preview (${safeErrMsg}).`,
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const buildInitialChecklist = (
    saved?: Record<string, QuranSurahHumanReviewEntry>,
  ): Record<string, QuranSurahHumanReviewEntry> => {
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
  };

  const checklistTally = React.useMemo(() => {
    let passedSurahs = 0;
    let reviewedAyahs = 0;
    let totalAyahs = 0;
    for (const surah of QURAN_SURAHS) {
      totalAyahs += surah.ayahCount;
      const entry = surahChecklistDraft[surah.id];
      if (!entry) continue;
      reviewedAyahs += entry.reviewedAyahNumbers.length;
      if (
        entry.reviewResult === 'passed' &&
        entry.reviewerName.trim() &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) &&
        entry.notes.trim() &&
        entry.reviewedAyahNumbers.length === surah.ayahCount
      ) {
        passedSurahs++;
      }
    }
    return {
      passedSurahs,
      totalSurahs: QURAN_SURAHS.length,
      reviewedAyahs,
      totalAyahs,
      allPassed: passedSurahs === QURAN_SURAHS.length && reviewedAyahs === totalAyahs,
    };
  }, [surahChecklistDraft]);

  const startEditingReciter = (r: QuranReciterSpec) => {
    const existingRecord = data?.customRecords?.find((rec) => rec.contentKey === r.id);
    setEditingKey(r.id);
    setStatusDraft(r.verificationStatus);
    setSourceDraft(r.sourceName);
    setLicenseDraft(r.licenseOrPermission);
    setReviewerDraft(r.tajweedReviewedBy || '');
    setAudioUrlsText(r.surahAudioUrls ? JSON.stringify(r.surahAudioUrls, null, 2) : '{}');
    setAyahUrlsText(r.ayahAudioUrls ? JSON.stringify(r.ayahAudioUrls, null, 2) : '{}');
    setNotesDraft(existingRecord?.notes || '');
    setTextIntegrityConfirmed(Boolean(existingRecord?.textIntegrityConfirmed));
    setAudioIntegrityConfirmed(Boolean(existingRecord?.audioIntegrityConfirmed));
    setReciterIdentityConfirmed(Boolean(existingRecord?.reciterIdentityConfirmed));
    setSurahChecklistDraft(buildInitialChecklist(existingRecord?.surahChecklist));
    const prevConfs = existingRecord?.adminConfirmations;
    const devTermsConf =
      prevConfs?.qfDeveloperTermsAndCommercialUse ||
      prevConfs?.qfAttributionAndTerms || {
        confirmed: Boolean(existingRecord?.licenseTermsConfirmed),
      };
    const attrCreditConf =
      prevConfs?.qfAttributionAndReciterCredit ||
      prevConfs?.qfAttributionAndTerms || {
        confirmed: Boolean(existingRecord?.licenseTermsConfirmed),
      };
    setAdminConfDraft({
      qfDeveloperTermsAndCommercialUse: devTermsConf,
      qfAttributionAndReciterCredit: attrCreditConf,
      qfAttributionAndTerms: {
        confirmed: devTermsConf.confirmed && attrCreditConf.confirmed,
      },
      sevenDayCachePolicy: prevConfs?.sevenDayCachePolicy || { confirmed: false },
      privacyAndTermsReadiness: prevConfs?.privacyAndTermsReadiness || { confirmed: false },
      humanTajweedApproval: prevConfs?.humanTajweedApproval || {
        confirmed: Boolean(existingRecord?.tajweedListeningConfirmed),
      },
      basmalaAudioApproval: prevConfs?.basmalaAudioApproval || { confirmed: false },
    });
  };

  const updateSurahChecklistEntry = (
    surahId: string,
    patch: Partial<QuranSurahHumanReviewEntry>,
  ) => {
    setSurahChecklistDraft((prev) => {
      const current = prev[surahId];
      if (!current) return prev;
      return {
        ...prev,
        [surahId]: {
          ...current,
          ...patch,
        },
      };
    });
  };

  const toggleChecklistAyah = (surahId: string, ayahNum: number) => {
    setSurahChecklistDraft((prev) => {
      const current = prev[surahId];
      if (!current) return prev;
      const set = new Set(current.reviewedAyahNumbers);
      if (set.has(ayahNum)) {
        set.delete(ayahNum);
      } else {
        set.add(ayahNum);
      }
      return {
        ...prev,
        [surahId]: {
          ...current,
          reviewedAyahNumbers: Array.from(set).sort((a, b) => a - b),
        },
      };
    });
  };

  const submitReciterVerification = async (targetStatus: QuranVerificationStatus) => {
    if (!editingKey) return;
    onError('');
    let parsedUrls: Record<string, string> = {};
    let parsedAyahUrls: Record<string, string> = {};
    try {
      const raw = JSON.parse(audioUrlsText || '{}');
      if (raw && typeof raw === 'object') parsedUrls = raw as Record<string, string>;
    } catch {
      onError(language === 'ar' ? 'صيغة JSON لروابط السور غير صحيحة.' : 'Invalid audioUrlsJson format.');
      return;
    }
    try {
      const rawAyah = JSON.parse(ayahUrlsText || '{}');
      if (rawAyah && typeof rawAyah === 'object') parsedAyahUrls = rawAyah as Record<string, string>;
    } catch {
      onError(language === 'ar' ? 'صيغة JSON لروابط الآيات غير صحيحة.' : 'Invalid ayahAudioUrlsJson format.');
      return;
    }

    const allConfirmationsDone =
      adminConfDraft.qfDeveloperTermsAndCommercialUse.confirmed &&
      adminConfDraft.qfAttributionAndReciterCredit.confirmed &&
      adminConfDraft.sevenDayCachePolicy.confirmed &&
      adminConfDraft.privacyAndTermsReadiness.confirmed &&
      adminConfDraft.humanTajweedApproval.confirmed &&
      adminConfDraft.basmalaAudioApproval.confirmed;

    if (
      targetStatus === 'verified' &&
      (!textIntegrityConfirmed ||
        !audioIntegrityConfirmed ||
        !reciterIdentityConfirmed ||
        !allConfirmationsDone ||
        !checklistTally.allPassed ||
        data?.phraseAssets?.basmala.status !== 'approved')
    ) {
      onError(
        language === 'ar'
          ? 'لا يمكن اعتماد القارئ والإطلاق للعائلات قبل إتمام قائمة المراجعة البشرية للسور التسع والـ ٤٠ آية، واعتماد البسملة، وتحديد جميع التأكيدات الإدارية.'
          : 'Cannot mark reciter verified until all 9 Surahs / 40 Ayahs pass human review, Basmala is approved, and all integrity & admin confirmations are checked.',
      );
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/quran/verifications/${encodeURIComponent(editingKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verificationStatus: targetStatus,
          sourceName: sourceDraft,
          licenseOrPermission: licenseDraft,
          tajweedReviewedBy: reviewerDraft,
          tajweedReviewedAt: reviewerDraft ? new Date().toISOString().slice(0, 10) : undefined,
          textIntegrityConfirmed,
          audioIntegrityConfirmed,
          reciterIdentityConfirmed,
          tajweedListeningConfirmed: adminConfDraft.humanTajweedApproval.confirmed,
          licenseTermsConfirmed:
            adminConfDraft.qfDeveloperTermsAndCommercialUse.confirmed &&
            adminConfDraft.qfAttributionAndReciterCredit.confirmed &&
            adminConfDraft.sevenDayCachePolicy.confirmed &&
            adminConfDraft.privacyAndTermsReadiness.confirmed,
          surahChecklist: surahChecklistDraft,
          adminConfirmations: {
            qfDeveloperTermsAndCommercialUse:
              adminConfDraft.qfDeveloperTermsAndCommercialUse.confirmed,
            qfAttributionAndReciterCredit:
              adminConfDraft.qfAttributionAndReciterCredit.confirmed,
            qfAttributionAndTerms:
              adminConfDraft.qfDeveloperTermsAndCommercialUse.confirmed &&
              adminConfDraft.qfAttributionAndReciterCredit.confirmed,
            sevenDayCachePolicy: adminConfDraft.sevenDayCachePolicy.confirmed,
            privacyAndTermsReadiness: adminConfDraft.privacyAndTermsReadiness.confirmed,
            humanTajweedApproval: adminConfDraft.humanTajweedApproval.confirmed,
            basmalaAudioApproval: adminConfDraft.basmalaAudioApproval.confirmed,
          },
          audioUrlsJson: parsedUrls,
          ayahAudioUrlsJson: parsedAyahUrls,
          notes: notesDraft,
        }),
      });
      const resp = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(resp.error || 'Failed to update verification record.');
        return;
      }
      onNotice(
        targetStatus === 'verified'
          ? `Released & verified ${editingKey} — Family access enabled.`
          : `Saved review draft for ${editingKey} (status=${targetStatus}).`,
      );
      setEditingKey('');
      await loadVerifications();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveReciter = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitReciterVerification(statusDraft);
  };

  const startEditingPhrase = (asset: QuranPhraseAudioAssetConfig) => {
    setEditingPhraseKey(asset.phraseKey);
    setPhraseUrlDraft(asset.audioUrl || '');
    setPhraseSourceDraft(asset.sourceName);
    setPhraseLicenseDraft(asset.licenseOrPermission);
    setPhraseReviewerDraft(asset.reviewedBy || '');
    setPhraseReviewedAtDraft(asset.reviewedAt || '');
    setPhraseNotesDraft(asset.notes || '');
    setPhraseLicenseConfirmed(asset.licenseConfirmed);
    setPhraseHumanApproved(asset.humanListeningApproved);
    setPhraseStatusDraft(asset.status === 'approved' ? 'verified' : 'pending_verification');
  };

  const handleLoadQfBasmalaCandidate = async (asset: QuranPhraseAudioAssetConfig) => {
    onError('');
    const previewCandidate = qfPreview?.ayahAudioUrls?.['1:1'];
    if (previewCandidate) {
      startEditingPhrase(asset);
      setPhraseUrlDraft(previewCandidate);
      setPhraseSourceDraft('Quran Foundation Recitation ID 6 (Al-Husary 1:1 Basmala)');
      return;
    }
    setLoadingBasmalaCandidate(true);
    try {
      const res = await apiFetch('/api/admin/quran/internal-testing-audio');
      const json = (await res.json().catch(() => ({}))) as {
        basmalaCandidateAudioUrl?: string | null;
        ayahAudioUrls?: Record<string, string>;
        error?: string;
      };
      const candidate = json.basmalaCandidateAudioUrl || json.ayahAudioUrls?.['1:1'];
      if (!res.ok || !candidate) {
        onError(
          json.error ||
            (language === 'ar'
              ? 'تعذّر جلب مرشح البسملة (1:1) للقارئ رقم ٦ من Quran Foundation.'
              : 'Could not load QF Reciter ID 6 Basmala (1:1) candidate URL.'),
        );
        return;
      }
      startEditingPhrase(asset);
      setPhraseUrlDraft(candidate);
      setPhraseSourceDraft('Quran Foundation Recitation ID 6 (Al-Husary 1:1 Basmala)');
    } finally {
      setLoadingBasmalaCandidate(false);
    }
  };

  const handleSavePhraseAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPhraseKey) return;
    onError('');

    if (
      phraseStatusDraft === 'verified' &&
      (!phraseUrlDraft.trim() ||
        !phraseLicenseConfirmed ||
        !phraseHumanApproved ||
        !phraseLicenseDraft.trim() ||
        !phraseReviewerDraft.trim())
    ) {
      onError(
        language === 'ar'
          ? 'لا يمكن اعتماد عبارة الافتتاح أو الختام قبل إدخال رابط صوتي موثوق واسم المراجع وشروط الترخيص وتأكيد خانات الترخيص والاستماع البشري.'
          : 'Cannot approve Opening/Closing phrase asset until audio URL, license details, reviewer name, License Confirmed, and Human Listening Approved are all completed.',
      );
      return;
    }

    setSavingPhrase(true);
    try {
      const res = await apiFetch(
        `/api/admin/quran/phrase-assets/${encodeURIComponent(editingPhraseKey)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioUrl: phraseUrlDraft.trim(),
            sourceName: phraseSourceDraft.trim(),
            licenseOrPermission: phraseLicenseDraft.trim(),
            reviewedBy: phraseReviewerDraft.trim(),
            reviewedAt: phraseReviewedAtDraft.trim() || undefined,
            licenseConfirmed: phraseLicenseConfirmed,
            humanListeningApproved: phraseHumanApproved,
            verificationStatus: phraseStatusDraft,
            notes: phraseNotesDraft.trim(),
          }),
        },
      );
      const resp = await res.json().catch(() => ({}));
      if (!res.ok) {
        onError(resp.error || 'Failed to update Quran phrase audio configuration.');
        return;
      }
      onNotice(
        language === 'ar'
          ? `تم تحديث إعداد الصوت لعبارة (${editingPhraseKey}) مع الحفاظ على حالة اعتماد السور والقارئ مستقلة.`
          : `Updated ${editingPhraseKey} phrase audio configuration (status: ${resp.asset?.status || 'updated'}).`,
      );
      setEditingPhraseKey('');
      await loadVerifications();
    } finally {
      setSavingPhrase(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Dedicated Quran World – Release Approval Workflow */}
      <QuranReleaseApprovalSection
        apiFetch={apiFetch}
        data={data}
        qfConfigured={Boolean(qfStatus?.quranFoundationConfigured)}
        qfPreview={qfPreview}
        language={language}
        onReload={loadVerifications}
        onNotice={onNotice}
        onError={onError}
      />
      {/* Verified Uthmani Text Provenance Registry (Read-Only) */}
      <div className="nono-card rounded-3xl p-5 bg-white space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-extrabold text-[#27345C] flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-[#047857]" />
              <span>
                {language === 'ar'
                  ? 'سجل توثيق النصوص القرآنية العثمانية (للقراءة فقط)'
                  : 'Verified Uthmani Quran Text Provenance Registry (Immutable)'}
              </span>
            </h3>
            <p className="text-xs font-bold text-[#27345C]/70 mt-0.5">
              {language === 'ar'
                ? 'تم فحص ومطابقة SHA-256 لجميع السور التسع مباشرة مع مصحف المدينة المنورة (api.quran.com v4).'
                : 'All 9 Surahs SHA-256 verified verbatim against King Fahd Complex Medina Mushaf (api.quran.com v4).'}
            </p>
          </div>
          <span className="px-3 py-1 rounded-xl bg-[#DCFCE7] text-[#166534] text-xs font-extrabold flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" />
            <span>{QURAN_SURAHS.length} Surahs Verified</span>
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          {(data?.surahTexts || []).map((s) => (
            <div key={s.contentKey} className="p-3.5 rounded-2xl bg-[#FFFDF7] border border-[#B4862C]/25 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-extrabold text-[#27345C]">
                  {s.nameAr} · {s.nameEn}
                </p>
                <span className="px-2 py-0.5 rounded-lg bg-[#DCFCE7] text-[#166534] text-[10px] font-extrabold">
                  {s.verificationStatus}
                </span>
              </div>
              <p className="text-[#27345C]/70 font-bold tabular-nums">
                {s.contentKey} · {s.ayahCount} ayahs
              </p>
              <p className="font-mono-num text-[10px] text-[#27345C]/65 truncate" title={s.textSha256}>
                SHA-256: {s.textSha256}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Quran Foundation Server Status & Sync Preview (Read-Only / Never Auto-Verifies) */}
      <div className="nono-card rounded-3xl p-5 bg-white space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-extrabold text-[#27345C]">
              {language === 'ar'
                ? 'تكامل مصدر Quran Foundation الرسمي (الخادم فقط)'
                : 'Official Quran Foundation Audio Provider (Server-Only)'}
            </h3>
            <p className="text-[#27345C]/75 font-bold mt-0.5">
              {qfStatus
                ? qfStatus.singleDefaultReciter.attribution[language]
                : language === 'ar'
                  ? 'الشيخ محمود خليل الحصري – رواية حفص عن عاصم – تلاوة مرتلة'
                  : "Sheikh Mahmoud Khalil Al-Husary – Hafs 'an 'Asim – Murattal"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded-xl font-extrabold ${
                qfStatus?.quranFoundationConfigured
                  ? 'bg-[#DCFCE7] text-[#166534]'
                  : 'bg-[#FEF3C7] text-[#92400E]'
              }`}
            >
              {qfStatus?.quranFoundationConfigured
                ? language === 'ar'
                  ? 'QF Secrets مهيّأة على الخادم ✓'
                  : 'QF Server Secrets Configured ✓'
                : language === 'ar'
                  ? 'QF Secrets غير مضافة بعد'
                  : 'QF Secrets Not Configured'}
            </span>
            <button
              type="button"
              disabled={previewLoading}
              onClick={() => void handleRunQfPreview()}
              className="min-h-[38px] px-3.5 rounded-xl bg-[#047857] text-white font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${previewLoading ? 'animate-spin' : ''}`} />
              <span>{language === 'ar' ? 'معاينة Quran Foundation' : 'Preview Quran Foundation'}</span>
            </button>
          </div>
        </div>

        {qfStatus && !qfStatus.quranFoundationConfigured && (
          <p className="p-3 rounded-2xl bg-[#FFFBEB] border border-[#D97706]/30 text-[#92400E] font-bold">
            {language === 'ar'
              ? 'أضف QF_CLIENT_ID و QF_CLIENT_SECRET في إعدادات Secrets الخاصة بالخادم (وليس في الواجهة الأمامية) لتفعيل معاينة روابط الشيخ الحصري المرتل.'
              : 'Configure QF_CLIENT_ID and QF_CLIENT_SECRET in server-side Secrets (never in frontend code) to fetch preview recitation URLs from Quran Foundation.'}
          </p>
        )}

        {qfPreview && (
          <div
            className={`p-3.5 rounded-2xl border space-y-3 ${
              !qfPreview.ok
                ? 'bg-[#FEF2F2] border-[#DC2626]/30'
                : 'bg-[#F8FAFC] border-[#27345C]/12'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-extrabold text-[#27345C]">
                {!qfPreview.ok
                  ? language === 'ar'
                    ? 'تعذّر إتمام معاينة Quran Foundation:'
                    : 'Quran Foundation Preview Failed:'
                  : language === 'ar'
                    ? 'نتيجة المعاينة (قيد التحقق — غير معتمدة تلقائياً):'
                    : 'Sync Preview Output (pending_verification — never auto-verified):'}
              </p>
              <span
                className={`px-2 py-0.5 rounded-lg text-[11px] font-mono-num font-extrabold ${
                  qfPreview.resOk ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#FEE2E2] text-[#991B1B]'
                }`}
                dir="ltr"
              >
                HTTP {qfPreview.httpStatus}
              </span>
            </div>

            {qfPreview.error && (
              <p className="p-2.5 rounded-xl bg-white border border-[#DC2626]/30 text-[#991B1B] font-bold" dir="ltr">
                {qfPreview.error}
              </p>
            )}

            <p className="text-[#27345C]/75">
              Surahs found: {Object.keys(qfPreview.surahAudioUrls || {}).length} · Ayahs found:{' '}
              {Object.keys(qfPreview.ayahAudioUrls || {}).length}
            </p>

            {qfPreview.notice && (
              <p className={!qfPreview.ok ? 'text-[#991B1B] font-bold' : 'text-[#92400E] font-bold'}>
                {qfPreview.notice}
              </p>
            )}

            {/* Dedicated Quran Foundation Diagnostics Section (Always rendered after Preview attempt) */}
            <div
              className="p-3.5 rounded-xl bg-white border border-[#27345C]/15 space-y-2.5 text-[11px] font-mono-num"
              dir="ltr"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#27345C]/10 pb-2">
                <p className="font-extrabold text-xs text-[#27345C]">
                  Quran Foundation Diagnostics
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopyDiagnostics()}
                  className="px-2.5 py-1 rounded-lg bg-[#27345C] text-white font-bold flex items-center gap-1.5 cursor-pointer hover:opacity-90"
                >
                  {copiedDiag ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedDiag ? 'Copied' : 'Copy Diagnostics'}</span>
                </button>
              </div>

              {!qfPreview.diagnostics ? (
                <div className="space-y-1.5 text-[#27345C]/85">
                  <p className="p-2 rounded-lg bg-[#FFFBEB] border border-[#D97706]/30 text-[#92400E] font-bold">
                    {qfPreview.failureStage === 'BACKEND_ROUTING_OR_STARTUP_HTML'
                      ? 'Backend routing/startup error: HTML received instead of API JSON'
                      : 'Diagnostics were not returned by the server'}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                    <p>
                      <strong>HTTP status:</strong> {qfPreview.httpStatus}
                    </p>
                    <p>
                      <strong>Exact failure stage:</strong> {qfPreview.failureStage}
                    </p>
                    <p>
                      <strong>Content-Type:</strong> {qfPreview.safeResponseSummary.contentType}
                    </p>
                    <p>
                      <strong>Express API header:</strong>{' '}
                      {String(qfPreview.safeResponseSummary.expressHeaderPresent)}
                    </p>
                    {qfPreview.safeResponseSummary.htmlTitle && (
                      <p className="md:col-span-2">
                        <strong>HTML title:</strong> {qfPreview.safeResponseSummary.htmlTitle}
                      </p>
                    )}
                    <p>
                      <strong>Valid HTTPS audio URLs found:</strong> {qfPreview.validHttpsTotalCount} (Surahs:{' '}
                      {qfPreview.validHttpsSurahCount}, Ayahs: {qfPreview.validHttpsAyahCount})
                    </p>
                    <p className="break-all">
                      <strong>Request route:</strong> {qfPreview.requestPath}
                    </p>
                  </div>
                  <p className="break-words">
                    <strong>Safe response keys:</strong>{' '}
                    {qfPreview.safeResponseSummary.topLevelKeys.length > 0
                      ? qfPreview.safeResponseSummary.topLevelKeys.join(', ')
                      : 'none (non-JSON or empty body)'}
                  </p>
                  {qfPreview.safeResponseSummary.safeTextSnippet && (
                    <p className="break-all text-[#991B1B]">
                      <strong>Safe response snippet:</strong> {qfPreview.safeResponseSummary.safeTextSnippet}
                    </p>
                  )}
                  <p className="break-words">
                    <strong>Final error:</strong> {qfPreview.error || 'None'}
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5 text-[#27345C]/85">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                    <p>
                      <strong>HTTP status:</strong> {qfPreview.httpStatus}
                    </p>
                    <p>
                      <strong>Exact failure stage:</strong> {qfPreview.failureStage}
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Requested scopes ({qfPreview.diagnostics.scopeConfigSource}):</strong>{' '}
                      {qfPreview.diagnostics.requestedScopes.length > 0
                        ? qfPreview.diagnostics.requestedScopes.join(' ')
                        : qfPreview.diagnostics.oauthPrimary?.scopeRequested || 'None'}
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Actual granted scopes:</strong>{' '}
                      {qfPreview.diagnostics.grantedScopes.length > 0
                        ? qfPreview.diagnostics.grantedScopes.join(' ')
                        : qfPreview.diagnostics.oauthPrimary?.grantedScope
                          ? qfPreview.diagnostics.oauthPrimary.grantedScope
                          : qfPreview.diagnostics.oauthPrimary?.tokenReceived
                            ? 'Not returned by OAuth server'
                            : 'None'}
                    </p>
                    <p>
                      <strong>OAuth status:</strong>{' '}
                      {qfPreview.diagnostics.oauthPrimary
                        ? `HTTP ${qfPreview.diagnostics.oauthPrimary.httpStatus} · ok=${String(
                            qfPreview.diagnostics.oauthPrimary.ok,
                          )} · method=${qfPreview.diagnostics.oauthPrimary.authMethod} · tokenReceived=${String(
                            qfPreview.diagnostics.oauthPrimary.tokenReceived,
                          )}`
                        : 'Not executed'}
                    </p>
                    <p>
                      <strong>API base URL:</strong> {qfPreview.diagnostics.contentApiBaseUrl || 'N/A'} (
                      {qfPreview.diagnostics.environment})
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>OAuth error code &amp; description:</strong>{' '}
                      {qfPreview.diagnostics.oauthPrimary?.errorCode ||
                      qfPreview.diagnostics.oauthPrimary?.errorDescription
                        ? `${qfPreview.diagnostics.oauthPrimary.errorCode || 'N/A'} — ${
                            qfPreview.diagnostics.oauthPrimary.errorDescription || 'N/A'
                          }`
                        : 'None'}
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Chapter API status (content.quran.read):</strong>{' '}
                      {qfPreview.diagnostics.chapterApi
                        ? `ok=${String(qfPreview.diagnostics.chapterApi.ok)} · scopeApproved=${String(
                            qfPreview.diagnostics.chapterApi.scopeApproved,
                          )} · chapters HTTP ${
                            qfPreview.diagnostics.chapterApi.chaptersList.httpStatus
                          } (count=${qfPreview.diagnostics.chapterApi.chaptersList.chaptersCount ?? 0})${
                            qfPreview.diagnostics.chapterApi.verseSample
                              ? ` · verses HTTP ${qfPreview.diagnostics.chapterApi.verseSample.httpStatus} (count=${
                                  qfPreview.diagnostics.chapterApi.verseSample.versesCount ?? 0
                                })`
                              : ''
                          }${
                            qfPreview.diagnostics.chapterApi.chaptersList.errorMessage
                              ? ` [${qfPreview.diagnostics.chapterApi.chaptersList.errorMessage}]`
                              : ''
                          }`
                        : 'Not executed'}
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Reciter ID &amp; verification result:</strong> ID={qfPreview.reciterId ?? 6} ·{' '}
                      {qfPreview.diagnostics.reciterCheck
                        ? `verifiedHusaryId6=${String(qfPreview.diagnostics.reciterCheck.verifiedHusaryId6)}${
                            qfPreview.diagnostics.reciterCheck.chapterReciter
                              ? ` · chapter_reciters HTTP ${
                                  qfPreview.diagnostics.reciterCheck.chapterReciter.httpStatus
                                }${
                                  qfPreview.diagnostics.reciterCheck.chapterReciter.matchedName
                                    ? ` ("${qfPreview.diagnostics.reciterCheck.chapterReciter.matchedName}", ${
                                        qfPreview.diagnostics.reciterCheck.chapterReciter.style || '—'
                                      } / ${qfPreview.diagnostics.reciterCheck.chapterReciter.qirat || '—'})`
                                    : ''
                                }${
                                  qfPreview.diagnostics.reciterCheck.chapterReciter.errorMessage
                                    ? ` [${qfPreview.diagnostics.reciterCheck.chapterReciter.errorMessage}]`
                                    : ''
                                }`
                              : ''
                          }${
                            qfPreview.diagnostics.reciterCheck.verseRecitation
                              ? ` · recitations HTTP ${
                                  qfPreview.diagnostics.reciterCheck.verseRecitation.httpStatus
                                }${
                                  qfPreview.diagnostics.reciterCheck.verseRecitation.matchedName
                                    ? ` ("${qfPreview.diagnostics.reciterCheck.verseRecitation.matchedName}", ${
                                        qfPreview.diagnostics.reciterCheck.verseRecitation.style || '—'
                                      })`
                                    : ''
                                }${
                                  qfPreview.diagnostics.reciterCheck.verseRecitation.errorMessage
                                    ? ` [${qfPreview.diagnostics.reciterCheck.verseRecitation.errorMessage}]`
                                    : ''
                                }`
                              : ''
                          }`
                        : 'Not executed'}
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Audio API status (content.audio.read):</strong>{' '}
                      {qfPreview.diagnostics.audioApi
                        ? `ok=${String(qfPreview.diagnostics.audioApi.ok)} · scopeApproved=${String(
                            qfPreview.diagnostics.audioApi.scopeApproved,
                          )} · chapters ${qfPreview.diagnostics.audioApi.chapterAudiosOkCount}/${
                            qfPreview.diagnostics.audioApi.chapterAudiosTotalCount
                          } ok · verses ${qfPreview.diagnostics.audioApi.verseAudiosOkCount}/${
                            qfPreview.diagnostics.audioApi.verseAudiosTotalCount
                          } ok`
                        : 'Not executed'}
                    </p>
                    <p>
                      <strong>Chapter audio request status:</strong>{' '}
                      {summarizeEndpointStatuses(qfPreview.diagnostics.chapterAudios)}
                    </p>
                    <p>
                      <strong>Verse audio request status:</strong>{' '}
                      {summarizeEndpointStatuses(qfPreview.diagnostics.verseAudios)}
                    </p>
                    <p>
                      <strong>Valid HTTPS audio URLs found:</strong> {qfPreview.validHttpsTotalCount} (Surahs:{' '}
                      {qfPreview.validHttpsSurahCount}, Ayahs: {qfPreview.validHttpsAyahCount})
                    </p>
                    <p className="md:col-span-2 break-words">
                      <strong>Final error:</strong> {qfPreview.error || 'None'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {qfPreview.validation && (
              <div
                className="p-3.5 rounded-xl bg-white border border-[#8054D9]/25 space-y-3 text-[11px]"
                dir="ltr"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#27345C]/10 pb-2">
                  <p className="font-extrabold text-xs text-[#27345C]">
                    Final Validation Stage (Validation-Only · verificationStatus={qfPreview.validation.verificationStatus})
                  </p>
                  <span className="px-2 py-0.5 rounded-lg bg-[#FEF3C7] text-[#92400E] font-extrabold">
                    autoApproved=false · autoPublished=false
                  </span>
                </div>

                {/* 5 Separate Workflow Statuses */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  {[
                    { label: '1. Text Integrity', value: qfPreview.validation.workflowStatuses.textIntegrity },
                    { label: '2. Audio Integrity', value: qfPreview.validation.workflowStatuses.audioIntegrity },
                    { label: '3. Reciter Identity', value: qfPreview.validation.workflowStatuses.reciterIdentity },
                    { label: '4. Tajweed Review', value: qfPreview.validation.workflowStatuses.tajweedReview },
                    { label: '5. License Confirmation', value: qfPreview.validation.workflowStatuses.licenseConfirmation },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="p-2 rounded-lg bg-[#F8FAFC] border border-[#27345C]/10 space-y-1"
                    >
                      <p className="font-extrabold text-[#27345C]/75">{item.label}</p>
                      <span
                        className={`inline-block px-2 py-0.5 rounded font-mono-num font-extrabold ${
                          item.value === 'passed'
                            ? 'bg-[#DCFCE7] text-[#166534]'
                            : item.value === 'failed'
                              ? 'bg-[#FEE2E2] text-[#991B1B]'
                              : 'bg-[#FEF3C7] text-[#92400E]'
                        }`}
                      >
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Text Coverage & Scope Explanation */}
                {qfPreview.validation.textCoverage && (
                  <div className="p-2.5 rounded-lg bg-[#FFFDF7] border border-[#B4862C]/25 space-y-1">
                    <p className="font-extrabold text-[#27345C]">
                      Quran Text Coverage ({qfPreview.validation.textCoverage.status})
                    </p>
                    <p className="text-[#27345C]/80 font-mono-num">
                      Provider Chapters: {qfPreview.validation.textCoverage.providerChaptersCount}/
                      {qfPreview.validation.textCoverage.authoritativeTotalChapters} · Curated Preview Surahs:{' '}
                      {qfPreview.validation.textCoverage.curatedChaptersCount} · Curated Ayahs:{' '}
                      {qfPreview.validation.textCoverage.curatedAyahsCount}/
                      {qfPreview.validation.textCoverage.authoritativeTotalAyahs} · Missing Ayahs:{' '}
                      {qfPreview.validation.textCoverage.totalMissingAyahs} · Duplicate Ayahs:{' '}
                      {qfPreview.validation.textCoverage.totalDuplicateAyahs} · Unexpected Ayahs:{' '}
                      {qfPreview.validation.textCoverage.totalUnexpectedAyahs} · Uthmani Mismatches:{' '}
                      {qfPreview.validation.textCoverage.totalUthmaniMismatches} · SHA-256 Match:{' '}
                      {String(qfPreview.validation.textCoverage.allLocalSha256Matched)}
                    </p>
                    <p className="text-[#27345C]/75">{qfPreview.validation.textCoverage.scopeExplanation}</p>
                  </div>
                )}

                {/* Audio Coverage & Real Playability Verification */}
                {qfPreview.validation.audioCoverage && (
                  <div className="p-2.5 rounded-lg bg-[#F8FAFC] border border-[#27345C]/10 space-y-1">
                    <p className="font-extrabold text-[#27345C]">
                      Audio Coverage &amp; Playability Probe ({qfPreview.validation.audioCoverage.status})
                    </p>
                    <p className="text-[#27345C]/80 font-mono-num">
                      Playable Verified URLs: {qfPreview.validation.audioCoverage.playableValidUrlCount}/
                      {qfPreview.validation.audioCoverage.uniqueUrlsChecked} · Playable Surahs:{' '}
                      {qfPreview.validation.audioCoverage.playableSurahCount}/
                      {qfPreview.validation.audioCoverage.expectedSurahCount} · Playable Ayahs:{' '}
                      {qfPreview.validation.audioCoverage.playableAyahCount}/
                      {qfPreview.validation.audioCoverage.expectedAyahCount} · Duplicates:{' '}
                      {qfPreview.validation.audioCoverage.duplicateUrls.length} · Invalid Resources:{' '}
                      {qfPreview.validation.audioCoverage.invalidResources.length}
                    </p>
                    {(qfPreview.validation.audioCoverage.missingSurahAudioIds.length > 0 ||
                      qfPreview.validation.audioCoverage.missingAyahKeys.length > 0) && (
                      <p className="text-[#991B1B] font-bold">
                        Missing audio — Surahs:{' '}
                        {qfPreview.validation.audioCoverage.missingSurahAudioIds.join(', ') || 'none'} · Ayahs:{' '}
                        {qfPreview.validation.audioCoverage.missingAyahKeys.slice(0, 12).join(', ') || 'none'}
                      </p>
                    )}
                    {qfPreview.validation.audioCoverage.invalidResources.length > 0 && (
                      <div className="space-y-1 pt-1">
                        {qfPreview.validation.audioCoverage.invalidResources.slice(0, 5).map((inv) => (
                          <p key={`${inv.kind}-${inv.targetKey}`} className="text-[#991B1B] font-mono-num">
                            Invalid {inv.kind} {inv.targetKey}: HTTP {inv.httpStatus} ({inv.contentType}) —{' '}
                            {inv.reason}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Reciter ID 6 Verification */}
                {qfPreview.validation.reciterVerification && (
                  <div className="p-2.5 rounded-lg bg-[#F5F3FF] border border-[#8054D9]/20 space-y-1">
                    <p className="font-extrabold text-[#27345C]">
                      Reciter Verification (ID={qfPreview.validation.reciterVerification.recitationId})
                    </p>
                    <p className="text-[#27345C]/80 font-mono-num">
                      Identity Confirmed: {String(qfPreview.validation.reciterVerification.identityConfirmedFromMetadata)}{' '}
                      ({qfPreview.validation.reciterVerification.matchedName || '—'} ·{' '}
                      {qfPreview.validation.reciterVerification.style || '—'} /{' '}
                      {qfPreview.validation.reciterVerification.qirat || '—'}) · Tajweed Inferred From Metadata:{' '}
                      {String(qfPreview.validation.reciterVerification.tajweedQualityInferredFromMetadata)} ·
                      Tajweed Review: {qfPreview.validation.reciterVerification.tajweedReviewStatus}
                    </p>
                    <p className="text-[#27345C]/75">{qfPreview.validation.reciterVerification.note}</p>
                  </div>
                )}

                {/* Passed / Failed / Pending Checks */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <div className="p-2.5 rounded-lg bg-[#DCFCE7]/50 border border-[#166534]/20 space-y-1">
                    <p className="font-extrabold text-[#166534]">
                      Passed ({qfPreview.validation.passedChecks.length})
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5 text-[#166534]">
                      {qfPreview.validation.passedChecks.map((c, idx) => (
                        <li key={idx}>{c}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#FEE2E2]/50 border border-[#991B1B]/20 space-y-1">
                    <p className="font-extrabold text-[#991B1B]">
                      Failed ({qfPreview.validation.failedChecks.length})
                    </p>
                    {qfPreview.validation.failedChecks.length === 0 ? (
                      <p className="text-[#27345C]/65">None</p>
                    ) : (
                      <ul className="list-disc pl-4 space-y-0.5 text-[#991B1B]">
                        {qfPreview.validation.failedChecks.map((c, idx) => (
                          <li key={idx}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#FEF3C7]/60 border border-[#92400E]/20 space-y-1">
                    <p className="font-extrabold text-[#92400E]">
                      Pending Human / Admin ({qfPreview.validation.pendingChecks.length})
                    </p>
                    <ul className="list-disc pl-4 space-y-0.5 text-[#92400E]">
                      {qfPreview.validation.pendingChecks.map((c, idx) => (
                        <li key={idx}>{c}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {editingKey === 'adult-husary-muallim' &&
              (qfPreview.validHttpsSurahCount > 0 || qfPreview.validHttpsAyahCount > 0) && (
                <button
                  type="button"
                  onClick={() => {
                    setAudioUrlsText(JSON.stringify(qfPreview.surahAudioUrls || {}, null, 2));
                    setAyahUrlsText(JSON.stringify(qfPreview.ayahAudioUrls || {}, null, 2));
                  }}
                  className="px-3 py-1.5 rounded-xl bg-[#8054D9] text-white font-extrabold cursor-pointer"
                >
                  {language === 'ar' ? 'نسخ روابط المعاينة إلى نموذج التوثيق' : 'Load Preview URLs into Verification Form'}
                </button>
              )}
          </div>
        )}

        {/* Applicable License Terms, Attribution & Usage Restrictions Card */}
        {(qfPreview?.validation?.licenseAndAttribution || data?.licenseAndAttribution) && (
          <div className="p-3.5 rounded-2xl bg-[#FFFBEB] border border-[#D97706]/30 space-y-1.5 text-xs">
            <p className="font-extrabold text-[#92400E]">
              {language === 'ar'
                ? 'شروط الترخيص والإسناد وقيود الاستخدام (تتطلب تأكيد المشرف)'
                : 'Quran Foundation License, Attribution & Usage Restrictions (Requires Admin Confirmation)'}
            </p>
            <p className="font-bold text-[#27345C]">
              {(qfPreview?.validation?.licenseAndAttribution || data?.licenseAndAttribution)!.sourceName}
            </p>
            <p className="text-[#27345C]/80">
              {(qfPreview?.validation?.licenseAndAttribution || data?.licenseAndAttribution)!.attributionText}
            </p>
            <ul className="list-disc ps-5 space-y-0.5 text-[#27345C]/80">
              {(qfPreview?.validation?.licenseAndAttribution || data?.licenseAndAttribution)!.usageRestrictions.map(
                (rule, idx) => (
                  <li key={idx}>{rule}</li>
                ),
              )}
            </ul>
            <p className="font-extrabold text-[#047857]" dir="ltr">
              commercialEndUserUsePermitted=
              {String(
                (qfPreview?.validation?.licenseAndAttribution || data?.licenseAndAttribution)!
                  .commercialUsePermittedForIntegratedApp ?? true,
              )}{' '}
              · standaloneRedistribution=false · paidApiLicenseRequired=false · verificationStatus=pending_verification until human Tajweed &amp; terms confirmation
            </p>
          </div>
        )}
      </div>

      {/* Controlled Admin / Internal Testing Mode Quran Audio Player (never exposed to families/children) */}
      <AdminQuranTestingPlayer
        apiFetch={apiFetch}
        previewSurahAudioUrls={qfPreview?.surahAudioUrls}
        previewAyahAudioUrls={qfPreview?.ayahAudioUrls}
        previewBasmalaIncludedBySurah={qfPreview?.basmalaIncludedBySurah}
        phraseAssets={data?.phraseAssets}
        onNotice={onNotice}
        onError={onError}
      />

      {/* Opening Basmala & Closing Phrase ("صَدَقَ اللَّهُ الْعَظِيمُ") Configuration & Approval */}
      {data?.phraseAssets && (
        <div className="nono-card rounded-3xl p-5 bg-white space-y-4 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-base sm:text-lg font-extrabold text-[#27345C]">
                {language === 'ar'
                  ? 'تهيئة واعتماد صوت البسملة وعبارة الختام (صَدَقَ اللَّهُ الْعَظِيمُ)'
                  : 'Opening Basmala & Closing Phrase Audio Configuration'}
              </h3>
              <p className="text-[#27345C]/75 font-bold mt-0.5">
                {language === 'ar'
                  ? 'عبارة الختام ليست آية قرآنية ولا تُضاف للنص العثماني أو عداد الآيات. تبقى معطّلة حتى يتم توفير تسجيل أصيل مرخّص ومعتمد بالاستماع البشري.'
                  : 'Closing phrase "صَدَقَ اللَّهُ الْعَظِيمُ" is never part of Quran text, Ayah numbering, or memorization counts, and stays disabled until an authentic licensed recording is configured & approved.'}
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-xl bg-[#FEF3C7] text-[#92400E] font-mono-num font-extrabold" dir="ltr">
              never fabricated · no TTS
            </span>
          </div>

          {/* 4 Separate Status Readouts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5" dir="ltr">
            <div className="p-3 rounded-2xl bg-[#F8FAFC] border border-[#27345C]/10 space-y-1">
              <p className="font-extrabold text-[#27345C]/70">Basmala audio</p>
              <span
                className={`inline-block px-2 py-0.5 rounded font-mono-num font-extrabold ${
                  data.phraseAssets.basmala.status === 'approved'
                    ? 'bg-[#DCFCE7] text-[#166534]'
                    : data.phraseAssets.basmala.status === 'configured_pending_approval'
                      ? 'bg-[#FEF3C7] text-[#92400E]'
                      : 'bg-slate-200 text-[#27345C]'
                }`}
              >
                {data.phraseAssets.basmala.status}
              </span>
            </div>

            <div className="p-3 rounded-2xl bg-[#F8FAFC] border border-[#27345C]/10 space-y-1">
              <p className="font-extrabold text-[#27345C]/70">Closing phrase audio</p>
              <span
                className={`inline-block px-2 py-0.5 rounded font-mono-num font-extrabold ${
                  data.phraseAssets.closing.status === 'approved'
                    ? 'bg-[#DCFCE7] text-[#166534]'
                    : data.phraseAssets.closing.status === 'configured_pending_approval'
                      ? 'bg-[#FEF3C7] text-[#92400E]'
                      : 'bg-slate-200 text-[#27345C]'
                }`}
              >
                {data.phraseAssets.closing.status}
              </span>
            </div>

            <div className="p-3 rounded-2xl bg-[#F8FAFC] border border-[#27345C]/10 space-y-1">
              <p className="font-extrabold text-[#27345C]/70">Audio license confirmation</p>
              <span className="inline-block px-2 py-0.5 rounded bg-white border border-[#27345C]/15 font-mono-num font-extrabold text-[#27345C]">
                Basmala: {String(data.phraseAssets.basmala.licenseConfirmed)} · Closing:{' '}
                {String(data.phraseAssets.closing.licenseConfirmed)}
              </span>
            </div>

            <div className="p-3 rounded-2xl bg-[#F8FAFC] border border-[#27345C]/10 space-y-1">
              <p className="font-extrabold text-[#27345C]/70">Human listening approval</p>
              <span className="inline-block px-2 py-0.5 rounded bg-white border border-[#27345C]/15 font-mono-num font-extrabold text-[#27345C]">
                Basmala: {String(data.phraseAssets.basmala.humanListeningApproved)} · Closing:{' '}
                {String(data.phraseAssets.closing.humanListeningApproved)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {([data.phraseAssets.basmala, data.phraseAssets.closing] as QuranPhraseAudioAssetConfig[]).map(
              (asset) => (
                <div
                  key={asset.phraseKey}
                  className="p-4 rounded-2xl bg-[#FFFDF7] border border-[#B4862C]/25 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-extrabold text-[#27345C]">
                      {asset.phraseAr} · {asset.labelEn}
                    </p>
                    <span
                      className={`px-2 py-0.5 rounded-lg text-[10px] font-mono-num font-extrabold ${
                        asset.status === 'approved'
                          ? 'bg-[#DCFCE7] text-[#166534]'
                          : asset.status === 'configured_pending_approval'
                            ? 'bg-[#FEF3C7] text-[#92400E]'
                            : 'bg-slate-200 text-[#27345C]'
                      }`}
                    >
                      {asset.status}
                    </span>
                  </div>
                  <p className="text-[#27345C]/75 font-bold break-all" dir="ltr">
                    URL: {asset.audioUrl || 'None (Disabled)'}
                  </p>
                  <p className="text-[#27345C]/70">{asset.licenseOrPermission}</p>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => startEditingPhrase(asset)}
                      className="min-h-[36px] px-3.5 rounded-xl bg-[#27345C] text-white font-extrabold cursor-pointer"
                    >
                      {asset.phraseKey === 'closing'
                        ? language === 'ar'
                          ? 'معطل حالياً (اختياري — لا يعطل الإطلاق)'
                          : 'Disabled (Optional / Non-Blocking)'
                        : language === 'ar'
                          ? 'تهيئة / اعتماد البسملة'
                          : 'Configure & Approve Basmala'}
                    </button>
                    {asset.phraseKey === 'basmala' && (
                      <button
                        type="button"
                        disabled={loadingBasmalaCandidate}
                        onClick={() => void handleLoadQfBasmalaCandidate(asset)}
                        className="min-h-[36px] px-3 rounded-xl bg-[#ECFDF5] border border-[#047857]/30 text-[#065F46] font-extrabold cursor-pointer disabled:opacity-50"
                      >
                        {loadingBasmalaCandidate
                          ? 'Loading QF 1:1...'
                          : language === 'ar'
                            ? 'جلب مرشح بسملة الحصري (1:1) من Quran Foundation'
                            : 'Load QF Reciter 6 (1:1) Candidate'}
                      </button>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          {editingPhraseKey && (
            <form
              onSubmit={(e) => void handleSavePhraseAsset(e)}
              className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#047857]/30 space-y-3 font-bold"
            >
              <div className="flex items-center justify-between">
                <p className="font-extrabold text-sm text-[#27345C]">
                  Configure Phrase Asset: {editingPhraseKey}
                  {editingPhraseKey === 'closing' ? ' (Optional — Keep Disabled Unless Licensed)' : ' (QF Reciter ID 6 Candidate Required for 8 Surahs)'}
                </p>
                <button
                  type="button"
                  onClick={() => setEditingPhraseKey('')}
                  className="px-3 py-1 rounded-lg bg-slate-200 cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span>
                    {editingPhraseKey === 'basmala'
                      ? 'QF Reciter ID 6 Basmala (1:1) HTTPS URL'
                      : 'Audio URL (empty to keep disabled)'}
                  </span>
                  <input
                    type="text"
                    dir="ltr"
                    value={phraseUrlDraft}
                    onChange={(e) => setPhraseUrlDraft(e.target.value)}
                    placeholder="https://..."
                    className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15 font-mono-num"
                  />
                </label>

                <label className="space-y-1">
                  <span>Approval Status</span>
                  <select
                    value={phraseStatusDraft}
                    onChange={(e) => setPhraseStatusDraft(e.target.value as QuranVerificationStatus)}
                    className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                  >
                    <option value="pending_verification">pending_verification</option>
                    <option value="verified">verified (approved)</option>
                    <option value="unavailable">unavailable (disabled)</option>
                  </select>
                </label>

                <label className="space-y-1">
                  <span>Source / Attribution Name</span>
                  <input
                    type="text"
                    value={phraseSourceDraft}
                    onChange={(e) => setPhraseSourceDraft(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                  />
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="space-y-1">
                    <span>Human Listening Reviewer</span>
                    <input
                      type="text"
                      value={phraseReviewerDraft}
                      onChange={(e) => setPhraseReviewerDraft(e.target.value)}
                      placeholder="Authorized reviewer name"
                      className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                    />
                  </label>
                  <label className="space-y-1">
                    <span>Review Date</span>
                    <input
                      type="date"
                      value={phraseReviewedAtDraft}
                      onChange={(e) => setPhraseReviewedAtDraft(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                    />
                  </label>
                </div>
              </div>

              <label className="block space-y-1">
                <span>Confirmed License / Usage Rights</span>
                <input
                  type="text"
                  value={phraseLicenseDraft}
                  onChange={(e) => setPhraseLicenseDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <label className="block space-y-1">
                <span>Reviewer Notes</span>
                <input
                  type="text"
                  value={phraseNotesDraft}
                  onChange={(e) => setPhraseNotesDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <div className="p-3 rounded-xl bg-white border border-[#047857]/20 space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={phraseLicenseConfirmed}
                    onChange={(e) => setPhraseLicenseConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Audio license &amp; usage rights explicitly confirmed by administrator.</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={phraseHumanApproved}
                    onChange={(e) => setPhraseHumanApproved(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Human listening review completed (authentic Reciter ID 6 Basmala verified, never TTS/AI).</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="submit"
                  disabled={savingPhrase}
                  className="min-h-[40px] px-5 rounded-xl bg-[#047857] text-white font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{language === 'ar' ? 'حفظ إعداد العبارة' : 'Save Phrase Asset'}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Reciters Verification & Licensing Registry */}
      <div className="nono-card rounded-3xl p-5 bg-white space-y-4">
        <div>
          <h3 className="text-lg font-extrabold text-[#27345C] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#8054D9]" />
            <span>
              {language === 'ar'
                ? 'اعتماد القراء والتلاوات الصوتية المرخّصة'
                : 'Quran Reciter Licensing & Tajweed Verification'}
            </span>
          </h3>
          <p className="text-xs font-bold text-[#27345C]/70 mt-0.5">
            {language === 'ar'
              ? 'لا يُسمح باعتماد أي قارئ بدون رابط صوتي موثوق (https:// أو /assets/quran/) ورخصة واضحة واسم مراجع التجويد.'
              : 'Reciters cannot be verified without explicit HTTPS or local asset URLs, license/permission, and a Tajweed reviewer.'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {(data?.reciters || []).map((r) => (
            <div key={r.id} className="p-4 rounded-2xl bg-[#FFF8E9] border border-[#27345C]/12 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-extrabold text-[#27345C]">{r.name[language]}</span>
                <span
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-extrabold ${
                    r.verificationStatus === 'verified'
                      ? 'bg-[#DCFCE7] text-[#166534]'
                      : 'bg-[#FEF3C7] text-[#92400E]'
                  }`}
                >
                  {r.verificationStatus}
                </span>
              </div>
              <p className="text-[#27345C]/75 font-bold">{r.style[language]}</p>
              <p className="text-[#27345C]/65">{r.licenseOrPermission}</p>
              <button
                type="button"
                onClick={() => startEditingReciter(r)}
                className="min-h-[38px] w-full rounded-xl bg-[#27345C] text-white font-extrabold cursor-pointer"
              >
                {language === 'ar' ? 'تحديث بيانات التوثيق' : 'Manage Verification'}
              </button>
            </div>
          ))}
        </div>

        {editingKey && (
          <form
            onSubmit={(e) => void handleSaveReciter(e)}
            className="p-4 rounded-2xl bg-[#F8FAFC] border border-[#8054D9]/30 space-y-3 text-xs font-bold"
          >
            <div className="flex items-center justify-between">
              <p className="font-extrabold text-sm text-[#27345C]">Edit Reciter: {editingKey}</p>
              <button
                type="button"
                onClick={() => setEditingKey('')}
                className="px-3 py-1 rounded-lg bg-slate-200 cursor-pointer"
              >
                Cancel
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span>Verification Status</span>
                <select
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value as QuranVerificationStatus)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                >
                  <option value="pending_verification">pending_verification</option>
                  <option value="verified">verified</option>
                  <option value="unavailable">unavailable</option>
                </select>
              </label>

              <label className="space-y-1">
                <span>Tajweed Reviewed By</span>
                <input
                  type="text"
                  value={reviewerDraft}
                  onChange={(e) => setReviewerDraft(e.target.value)}
                  placeholder="Sheikh / Committee Name"
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <label className="space-y-1">
                <span>Source Name</span>
                <input
                  type="text"
                  value={sourceDraft}
                  onChange={(e) => setSourceDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>

              <label className="space-y-1">
                <span>License / Permission</span>
                <input
                  type="text"
                  value={licenseDraft}
                  onChange={(e) => setLicenseDraft(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span>audioUrlsJson (Surah ID → https:// or /assets/quran/...)</span>
              <textarea
                rows={3}
                dir="ltr"
                value={audioUrlsText}
                onChange={(e) => setAudioUrlsText(e.target.value)}
                className="w-full p-2.5 rounded-xl bg-white border border-[#27345C]/15 font-mono-num"
              />
            </label>

            <label className="block space-y-1">
              <span>ayahAudioUrlsJson (Verse Key e.g. 1:1 → https:// or /assets/quran/...)</span>
              <textarea
                rows={3}
                dir="ltr"
                value={ayahUrlsText}
                onChange={(e) => setAyahUrlsText(e.target.value)}
                className="w-full p-2.5 rounded-xl bg-white border border-[#27345C]/15 font-mono-num"
              />
            </label>

            <label className="block space-y-1">
              <span>Notes</span>
              <input
                type="text"
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                className="w-full h-10 px-3 rounded-xl bg-white border border-[#27345C]/15"
              />
            </label>

            {/* 9-Surah / 40-Ayah Reciter ID 6 Human Listening & Tajweed Checklist */}
            <div className="p-3.5 rounded-2xl bg-white border border-[#047857]/25 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-extrabold text-[#27345C]">
                    {language === 'ar'
                      ? 'قائمة المراجعة البشرية للسور التسع والـ ٤٠ آية (Reciter ID 6)'
                      : 'Reciter ID 6 Human Review Checklist (All 9 Curated Surahs & 40 Ayahs)'}
                  </p>
                  <p className="text-[11px] text-[#27345C]/70">
                    {language === 'ar'
                      ? 'تُطلب مراجعة كل سورة وكل آية مع اسم المراجع، تاريخ المراجعة، النتيجة، والملاحظات.'
                      : 'Every Surah and Ayah requires reviewer name, review date, result (passed), and review notes. Nothing is auto-approved.'}
                  </p>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-xl font-mono-num font-extrabold ${
                    checklistTally.allPassed
                      ? 'bg-[#DCFCE7] text-[#166534]'
                      : 'bg-[#FEF3C7] text-[#92400E]'
                  }`}
                  dir="ltr"
                >
                  {checklistTally.passedSurahs}/{checklistTally.totalSurahs} Surahs ·{' '}
                  {checklistTally.reviewedAyahs}/{checklistTally.totalAyahs} Ayahs
                </span>
              </div>

              <div className="space-y-3">
                {QURAN_SURAHS.map((surah) => {
                  const entry = surahChecklistDraft[surah.id] || {
                    surahId: surah.id,
                    chapterNumber: surah.number,
                    ayahCount: surah.ayahCount,
                    reviewedAyahNumbers: [],
                    reviewerName: '',
                    reviewDate: '',
                    reviewResult: 'pending' as QuranSurahReviewResult,
                    notes: '',
                  };
                  const surahComplete =
                    entry.reviewResult === 'passed' &&
                    entry.reviewerName.trim().length > 0 &&
                    /^\d{4}-\d{2}-\d{2}$/.test(entry.reviewDate) &&
                    entry.notes.trim().length > 0 &&
                    entry.reviewedAyahNumbers.length === surah.ayahCount;

                  return (
                    <div
                      key={surah.id}
                      className={`p-3 rounded-xl border space-y-2.5 ${
                        surahComplete
                          ? 'bg-[#ECFDF5]/60 border-[#047857]/30'
                          : 'bg-[#F8FAFC] border-[#27345C]/12'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-extrabold text-[#27345C]">
                            {surah.nameEn} ({surah.number}) · {surah.nameAr}
                          </span>
                          <span className="px-2 py-0.5 rounded bg-white border border-[#27345C]/12 text-[10px] font-mono-num">
                            {surah.number === 1
                              ? 'Basmala Included (1:1 — Never Duplicated)'
                              : 'Requires Approved QF Basmala'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono-num text-[#27345C]/75">
                            {entry.reviewedAyahNumbers.length}/{surah.ayahCount} Ayahs listened
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const allSelected =
                                entry.reviewedAyahNumbers.length === surah.ayahCount;
                              updateSurahChecklistEntry(surah.id, {
                                reviewedAyahNumbers: allSelected
                                  ? []
                                  : surah.ayahs.map((a) => a.number),
                              });
                            }}
                            className="px-2 py-1 rounded-lg bg-white border border-[#27345C]/15 text-[11px] cursor-pointer hover:bg-[#F4EEFF]"
                          >
                            {entry.reviewedAyahNumbers.length === surah.ayahCount
                              ? 'Clear Ayahs'
                              : `Mark all ${surah.ayahCount} listened`}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5" dir="ltr">
                        {surah.ayahs.map((ayah) => {
                          const checked = entry.reviewedAyahNumbers.includes(ayah.number);
                          return (
                            <button
                              key={ayah.verseKey}
                              type="button"
                              onClick={() => toggleChecklistAyah(surah.id, ayah.number)}
                              className={`px-2 py-1 rounded-lg text-[11px] font-mono-num border cursor-pointer ${
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

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                        <input
                          type="text"
                          value={entry.reviewerName}
                          onChange={(e) =>
                            updateSurahChecklistEntry(surah.id, { reviewerName: e.target.value })
                          }
                          placeholder="Reviewer name *"
                          className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/15"
                        />
                        <input
                          type="date"
                          value={entry.reviewDate}
                          onChange={(e) =>
                            updateSurahChecklistEntry(surah.id, { reviewDate: e.target.value })
                          }
                          className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/15"
                        />
                        <select
                          value={entry.reviewResult}
                          onChange={(e) =>
                            updateSurahChecklistEntry(surah.id, {
                              reviewResult: e.target.value as QuranSurahReviewResult,
                            })
                          }
                          className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/15"
                        >
                          <option value="pending">pending</option>
                          <option value="passed">passed</option>
                          <option value="issues_found">issues_found</option>
                        </select>
                        <input
                          type="text"
                          value={entry.notes}
                          onChange={(e) =>
                            updateSurahChecklistEntry(surah.id, { notes: e.target.value })
                          }
                          placeholder="Listening & Tajweed notes *"
                          className="h-9 px-2.5 rounded-lg bg-white border border-[#27345C]/15"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Technical Integrity Checks + 5 Explicit Admin Confirmations (Recorded By & When) */}
            <div className="p-3.5 rounded-2xl bg-white border border-[#8054D9]/25 space-y-2.5">
              <p className="font-extrabold text-[#27345C]">
                {language === 'ar'
                  ? 'التحققات التقنية والتأكيدات الإدارية الخمس المنفصلة (مع توثيق المُؤكِّد والتاريخ):'
                  : 'Technical Integrity Checks & 5 Separate Explicit Admin Confirmations (Who & When Recorded):'}
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pb-2 border-b border-[#27345C]/10">
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl bg-[#F8FAFC]">
                  <input
                    type="checkbox"
                    checked={textIntegrityConfirmed}
                    onChange={(e) => setTextIntegrityConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Text Integrity (9 Surahs / 40 Ayahs SHA-256 matched)</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl bg-[#F8FAFC]">
                  <input
                    type="checkbox"
                    checked={audioIntegrityConfirmed}
                    onChange={(e) => setAudioIntegrityConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Audio Integrity (49 HTTPS URLs valid &amp; playable)</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer p-2 rounded-xl bg-[#F8FAFC]">
                  <input
                    type="checkbox"
                    checked={reciterIdentityConfirmed}
                    onChange={(e) => setReciterIdentityConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>Reciter Identity (Recitation ID 6 = Al-Husary, Murattal / Hafs)</span>
                </label>
              </div>

              {(
                [
                  {
                    key: 'qfDeveloperTermsAndCommercialUse',
                    title: '1. Quran Foundation Developer Terms & Integrated Commercial Use',
                    desc: 'Confirms Quran Foundation Developer Terms (updated Nov 20, 2026) and permitted end-user integrated commercial use.',
                    disabled: false,
                    disabledNote: '',
                  },
                  {
                    key: 'qfAttributionAndReciterCredit',
                    title: '2. Quran Foundation Attribution & Reciter Credit',
                    desc: 'Confirms "Quran data provided by Quran.Foundation." and Sheikh Mahmoud Khalil Al-Husary attribution.',
                    disabled: false,
                    disabledNote: '',
                  },
                  {
                    key: 'sevenDayCachePolicy',
                    title: '3. Seven-Day Server Cache Policy Confirmed',
                    desc: 'Confirms external QF audio URLs expire after 7 days unless re-synced (zero local MP3 rehosting).',
                    disabled: false,
                    disabledNote: '',
                  },
                  {
                    key: 'privacyAndTermsReadiness',
                    title: '4. Privacy Policy & Terms of Use Readiness Confirmed',
                    desc: 'Confirms public /privacy and /terms disclosures satisfy Quran Foundation Developer Privacy Policy requirements.',
                    disabled: false,
                    disabledNote: '',
                  },
                  {
                    key: 'humanTajweedApproval',
                    title: '5. Human Recitation / Tajweed Approval Confirmed',
                    desc: 'Confirms authorized human reviewer listened to all 9 Surahs & 40 Ayahs and passed Tajweed review.',
                    disabled: !checklistTally.allPassed,
                    disabledNote: `Complete 9/9 Surahs & 40/40 Ayahs above first (${checklistTally.passedSurahs}/9 passed).`,
                  },
                  {
                    key: 'basmalaAudioApproval',
                    title: '6. Basmala Audio Approval Confirmed (QF Reciter ID 6 Candidate)',
                    desc: 'Confirms verified QF Reciter ID 6 (1:1) Basmala candidate is approved for the 8 non-Fatihah Surahs (Al-Fatihah preserves 1:1 without duplication).',
                    disabled: data?.phraseAssets?.basmala.status !== 'approved',
                    disabledNote: `Approve the Basmala asset above first (current: ${data?.phraseAssets?.basmala.status || 'not_configured'}).`,
                  },
                ] as const
              ).map((item) => {
                const entry = adminConfDraft[item.key];
                return (
                  <label
                    key={item.key}
                    className={`flex items-start justify-between gap-3 p-2.5 rounded-xl border ${
                      item.disabled
                        ? 'bg-slate-50 border-slate-200 opacity-75 cursor-not-allowed'
                        : 'bg-[#FFFDF7] border-[#B4862C]/25 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        disabled={item.disabled}
                        checked={Boolean(entry?.confirmed)}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAdminConfDraft((prev) => ({
                            ...prev,
                            [item.key]: {
                              ...prev[item.key],
                              confirmed: checked,
                            },
                          }));
                        }}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-extrabold text-[#27345C]">{item.title}</p>
                        <p className="text-[11px] text-[#27345C]/70">{item.desc}</p>
                        {item.disabled && item.disabledNote && (
                          <p className="text-[11px] text-[#92400E] mt-0.5">{item.disabledNote}</p>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono-num text-[10px] px-2 py-1 rounded-lg bg-white border border-[#27345C]/12 text-[#27345C]/75">
                      {entry.confirmed && entry.confirmedBy
                        ? `${entry.confirmedBy} @ ${entry.confirmedAt?.slice(0, 10) || 'saved'}`
                        : entry.confirmed
                          ? 'Will stamp on save'
                          : 'Unconfirmed'}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[#27345C]/65 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                Closing phrase "صَدَقَ اللَّهُ الْعَظِيمُ" stays disabled &amp; does not block release.
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void submitReciterVerification('pending_verification')}
                  className="min-h-[40px] px-4 rounded-xl bg-[#27345C] text-white font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{language === 'ar' ? 'حفظ مسودة المراجعة (قيد الانتظار)' : 'Save Review Draft (Keep Pending)'}</span>
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[40px] px-5 rounded-xl bg-[#8054D9] text-white font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    {statusDraft === 'verified'
                      ? language === 'ar'
                        ? 'اعتماد وإتاحة الوصول للعائلات'
                        : 'Verify & Enable Family Access'
                      : language === 'ar'
                        ? 'حفظ التوثيق'
                        : 'Save Verification'}
                  </span>
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
