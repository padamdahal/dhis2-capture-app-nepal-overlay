import {
    NEPAL_BRANDING,
    NEPAL_FEATURES,
    NepaliDateAddon,
    adStringToBsParts,
    bsPartsToAd,
    formatDisplayDateTimeWithBs,
    formatDisplayDateWithBs,
    parseAndConvertBsInput,
} from './index';
import type { NepalExtensionAPI, NepalExtensionHost } from './runtime/extensionHost';

export {
    NEPAL_BRANDING,
    NEPAL_FEATURES,
    NepaliDateAddon,
    adStringToBsParts,
    bsPartsToAd,
    formatDisplayDateTimeWithBs as formatDisplayDateTime,
    formatDisplayDateWithBs as formatDisplayDate,
    parseAndConvertBsInput,
};

export const initNepalExtension = (host?: NepalExtensionHost): NepalExtensionAPI => {
    if (host && typeof globalThis !== 'undefined') {
        (globalThis as any).__CAPTURE_NP_HOST__ = host;
    }
    return {
        NEPAL_BRANDING,
        NEPAL_FEATURES,
        NepaliDateAddon,
        formatDisplayDate: formatDisplayDateWithBs,
        formatDisplayDateTime: formatDisplayDateTimeWithBs,
    };
};

export default initNepalExtension;
