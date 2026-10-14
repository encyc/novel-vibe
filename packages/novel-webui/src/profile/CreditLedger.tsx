import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { formatDate } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { formatCredit } from "./profile-utils";

export function CreditLedger() {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage);
  const [type, setType] = useState<"consume" | "topup" | "grant">("consume");
  const query = useInfiniteQuery({
    queryKey: ["credits", "transactions", type], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listCreditTransactions(type, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return <div className="credit-ledger">
    <div aria-label={t("profile.credits.ledger.aria")} className="ledger-tabs" role="tablist">
      <button aria-selected={type === "consume"} onClick={() => setType("consume")} role="tab" type="button">{t("profile.credits.ledger.consume")}</button>
      <button aria-selected={type === "topup"} onClick={() => setType("topup")} role="tab" type="button">{t("profile.credits.ledger.topup")}</button>
      <button aria-selected={type === "grant"} onClick={() => setType("grant")} role="tab" type="button">{t("profile.credits.ledger.grant")}</button>
    </div>
    {query.isLoading ? <p>{t("profile.credits.ledger.loading")}</p> : items.length === 0 ? <p className="profile-empty">{t(`profile.credits.ledger.${type === "consume" ? "emptyConsume" : type === "grant" ? "emptyGrant" : "emptyTopup"}`)}</p> : <div className="ledger-list">{items.map((item) => <div className="ledger-row" key={item.id}><div><strong>{item.description || t(item.type === "consume" ? "profile.credits.ledger.fallbackConsume" : "profile.credits.ledger.fallbackTopup")}</strong><span>{formatDate(item.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })}</span></div><div><strong data-positive={item.amount > 0}>{item.amount > 0 ? "+" : ""}{formatCredit(item.amount, locale)}</strong><span>{t("profile.credits.ledger.balance", { value: formatCredit(item.balanceAfter, locale) })}</span></div></div>)}</div>}
    {query.hasNextPage ? <button className="secondary-button ledger-more" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()} type="button">{t("profile.credits.ledger.loadMore")}</button> : null}
  </div>;
}
