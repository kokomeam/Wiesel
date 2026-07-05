/**
 * Copy language (Amendment 14) — all generated marketing copy is written in
 * the COURSE'S language, detected from the course plan (script-based heuristic
 * over the title/description/outcomes) and overridable per campaign via the
 * Campaign Brief (`brief.language`). Compliance/footer strings ship localized
 * for the supported locales below and fall back to English.
 *
 * The heuristic is deliberately script-based (CJK/Hangul/Cyrillic/etc.) —
 * reliable without a language-ID dependency. Latin-script languages other
 * than English (es/fr/de/…) can't be told apart heuristically, which is
 * exactly what the brief override is for.
 */

import type { CampaignBrief, CourseMarketingContext } from "./types";

export type SupportedLocale = "en" | "zh" | "ja" | "ko" | "ru" | "es" | "fr" | "de";

export const SUPPORTED_LOCALES: SupportedLocale[] = ["en", "zh", "ja", "ko", "ru", "es", "fr", "de"];

const LOCALE_LABEL: Record<SupportedLocale, string> = {
  en: "English",
  zh: "Chinese (Simplified)",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export function localeLabel(locale: string): string {
  return LOCALE_LABEL[(locale as SupportedLocale) in LOCALE_LABEL ? (locale as SupportedLocale) : "en"];
}

/** Script-based detection over the course's own text. Latin script → 'en'
 *  (the brief override handles es/fr/de/…). */
export function detectCourseLanguage(course: Pick<CourseMarketingContext, "title" | "description" | "outcomes">): SupportedLocale {
  const sample = [course.title, course.description ?? "", ...course.outcomes].join(" ");
  if (/[぀-ヿ]/.test(sample)) return "ja"; // hiragana/katakana beats CJK check
  if (/[가-힯]/.test(sample)) return "ko";
  if (/[一-鿿]/.test(sample)) return "zh";
  if (/[Ѐ-ӿ]/.test(sample)) return "ru";
  return "en";
}

/** The effective copy locale: brief override (when it's a supported locale) →
 *  detected course language → English. */
export function resolveCopyLocale(
  course: Pick<CourseMarketingContext, "title" | "description" | "outcomes">,
  brief?: CampaignBrief
): SupportedLocale {
  const override = brief?.language?.toLowerCase().slice(0, 2);
  if (override && (SUPPORTED_LOCALES as string[]).includes(override)) return override as SupportedLocale;
  return detectCourseLanguage(course);
}

/* ─────────────── localized compliance/footer strings ─────────────── */

export interface FooterStrings {
  /** "You're receiving this because you signed up." */
  receivingBecause: string;
  /** The unsubscribe link label. */
  unsubscribe: string;
}

const FOOTERS: Record<SupportedLocale, FooterStrings> = {
  en: { receivingBecause: "You're receiving this because you signed up.", unsubscribe: "Unsubscribe" },
  zh: { receivingBecause: "您收到此邮件是因为您曾订阅相关课程内容。", unsubscribe: "退订" },
  ja: { receivingBecause: "このメールは、ご登録いただいた方にお送りしています。", unsubscribe: "配信停止" },
  ko: { receivingBecause: "이 이메일은 구독을 신청하셨기 때문에 발송되었습니다.", unsubscribe: "수신 거부" },
  ru: { receivingBecause: "Вы получили это письмо, потому что подписались на рассылку.", unsubscribe: "Отписаться" },
  es: { receivingBecause: "Recibes este correo porque te suscribiste.", unsubscribe: "Cancelar suscripción" },
  fr: { receivingBecause: "Vous recevez cet e-mail car vous vous êtes inscrit(e).", unsubscribe: "Se désabonner" },
  de: { receivingBecause: "Sie erhalten diese E-Mail, weil Sie sich angemeldet haben.", unsubscribe: "Abmelden" },
};

/** Localized footer strings with an English fallback for anything unknown. */
export function footerStrings(locale: string): FooterStrings {
  return FOOTERS[(locale as SupportedLocale) in FOOTERS ? (locale as SupportedLocale) : "en"];
}
