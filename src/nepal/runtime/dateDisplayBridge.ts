import {
    formatDisplayDateTimeWithBs,
    formatDisplayDateWithBs,
    type DisplayDateFormatOptions,
} from '../calendar/bsDisplayFormatter';
import { getNepalExtension } from './extensionHost';

/**
 * Synchronous-first bridge for dual AD + BS read-only date display.
 *
 * Delegates to the hot-loaded `nepal-extension.js` bundle once ready (so fast
 * ~1.5s Nepal rebuilds can adjust display formatting), while falling back
 * synchronously to the bundled formatter on first paint so there is never an
 * AD-only flash in working lists, profiles, widgets, or view forms.
 */
export const formatDisplayDate = (
    localAdDate: string | null | undefined,
    options?: DisplayDateFormatOptions,
): string => {
    const ext = getNepalExtension();
    if (ext) {
        if (ext.NEPAL_FEATURES && ext.NEPAL_FEATURES.nepaliDateDisplay === false) {
            return typeof localAdDate === 'string' ? localAdDate : '';
        }
        if (typeof ext.formatDisplayDate === 'function') {
            return ext.formatDisplayDate(localAdDate, options);
        }
    }
    return formatDisplayDateWithBs(localAdDate, options);
};

export const formatDisplayDateTime = (
    localAdDate: string | null | undefined,
    timeString: string | null | undefined,
    options?: DisplayDateFormatOptions,
): string => {
    const ext = getNepalExtension();
    if (ext) {
        if (ext.NEPAL_FEATURES && ext.NEPAL_FEATURES.nepaliDateDisplay === false) {
            return [localAdDate, timeString].filter(Boolean).join(' ').trim();
        }
        if (typeof ext.formatDisplayDateTime === 'function') {
            return ext.formatDisplayDateTime(localAdDate, timeString, options);
        }
    }
    return formatDisplayDateTimeWithBs(localAdDate, timeString, options);
};
