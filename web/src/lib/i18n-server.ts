import en from "@/i18n/messages/en.json";

export function getTranslations(locale: string, namespace: string) {
  const ns = (en as Record<string, Record<string, string>>)[namespace];
  return (key: string): string => {
    return ns?.[key] || key;
  };
}
