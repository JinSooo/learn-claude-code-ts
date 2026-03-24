import en from "@/i18n/messages/en.json";
import zh from "@/i18n/messages/zh.json";

const allMessages: Record<string, Record<string, Record<string, string>>> = { en, zh };

export function getTranslations(locale: string, namespace: string) {
  const messages = allMessages[locale] || en;
  const ns = messages[namespace];
  return (key: string): string => {
    return ns?.[key] || key;
  };
}
