"use client";
import { createContext, useContext, ReactNode } from "react";
import en from "@/i18n/messages/en.json";

type Messages = typeof en;

const I18nContext = createContext<{ locale: string; messages: Messages }>({
  locale: "en",
  messages: en,
});

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", messages: en }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslations(namespace?: string) {
  const { messages } = useContext(I18nContext);
  return (key: string) => {
    const ns = namespace ? (messages as any)[namespace] : messages;
    if (!ns) return key;
    return (ns as any)[key] || key;
  };
}

export function useLocale() {
  return "en";
}
