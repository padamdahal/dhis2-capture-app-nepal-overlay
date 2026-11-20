import { NEPAL_FEATURES } from '../config/nepalConfig';
import { adStringToBsParts, type SupportedDateFormat } from './nepaliDate';

export type DisplayDateFormatOptions = {
    rawValue?: string | null;
    calendar?: string | null;
    dateFormat?: string | null;
};

const GREGORIAN_CALENDARS = new Set(['', 'gregorian', 'iso8601', 'iso']);

export const isGregorianCalendar = (calendar?: string | null): boolean => {
    if (!calendar) return true;
    return GREGORIAN_CALENDARS.has(String(calendar).trim().toLowerCase());
};

const normalizeDateFormat = (dateFormat?: string | null): SupportedDateFormat =>
    String(dateFormat || '').toUpperCase() === 'DD-MM-YYYY' ? 'DD-MM-YYYY' : 'YYYY-MM-DD';

const resolveBsIsoForDisplay = (
    localAdDate: string,
    options?: DisplayDateFormatOptions,
): string | null => {
    const preferredFormat = normalizeDateFormat(options?.dateFormat);
    const trimmedLocal = localAdDate.trim();

    // Prefer the already-localized AD date string first so BS always matches the
    // displayed local calendar day (e.g. UTC timestamps crossing midnight in NPT).
    if (trimmedLocal) {
        const fromLocalPreferred = adStringToBsParts(trimmedLocal, preferredFormat);
        if (fromLocalPreferred) return fromLocalPreferred.iso;

        const alternateFormat: SupportedDateFormat =
            preferredFormat === 'DD-MM-YYYY' ? 'YYYY-MM-DD' : 'DD-MM-YYYY';
        const fromLocalAlt = adStringToBsParts(trimmedLocal, alternateFormat);
        if (fromLocalAlt) return fromLocalAlt.iso;
    }

    const raw = options?.rawValue;
    if (raw && typeof raw === 'string') {
        const trimmedRaw = raw.trim();
        const isoMatch = trimmedRaw.match(/^(\d{4}-\d{2}-\d{2})/);
        if (isoMatch) {
            const fromRawIso = adStringToBsParts(isoMatch[1], 'YYYY-MM-DD');
            if (fromRawIso) return fromRawIso.iso;
        }
        const fromRawPreferred = adStringToBsParts(trimmedRaw, preferredFormat);
        if (fromRawPreferred) return fromRawPreferred.iso;
    }

    return null;
};

export const formatDisplayDateWithBs = (
    localAdDate: string | null | undefined,
    options?: DisplayDateFormatOptions,
): string => {
    const base = typeof localAdDate === 'string' ? localAdDate.trim() : '';
    if (!base) return '';
    if (!NEPAL_FEATURES.nepaliDateDisplay) return base;
    if (base.includes(' BS)')) return base;
    if (!isGregorianCalendar(options?.calendar)) return base;

    const bsIso = resolveBsIsoForDisplay(base, options);
    return bsIso ? `${base} (${bsIso} BS)` : base;
};

export const formatDisplayDateTimeWithBs = (
    localAdDate: string | null | undefined,
    timeString: string | null | undefined,
    options?: DisplayDateFormatOptions,
): string => {
    const datePart = typeof localAdDate === 'string' ? localAdDate.trim() : '';
    const timePart = typeof timeString === 'string' ? timeString.trim() : '';
    const base = [datePart, timePart].filter(Boolean).join(' ').trim();

    if (!base) return '';
    if (!datePart) return base;
    if (!NEPAL_FEATURES.nepaliDateDisplay) return base;
    if (base.includes(' BS)')) return base;
    if (!isGregorianCalendar(options?.calendar)) return base;

    const bsIso = resolveBsIsoForDisplay(datePart, options);
    return bsIso ? `${base} (${bsIso} BS)` : base;
};
