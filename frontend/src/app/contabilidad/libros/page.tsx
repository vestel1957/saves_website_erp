"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { TabBar } from "@/components/accounting/TabBar";
import { JournalTable } from "@/components/accounting/JournalTable";
import { LedgerTable } from "@/components/accounting/LedgerTable";
import { JournalEntryModal } from "@/components/accounting/JournalEntryModal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { Account, JournalEntry, Ledger } from "@/lib/accounting-types";

type Tab = "diario" | "mayor";

export default function LibrosPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [tab, setTab] = useState<Tab>("diario");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<{ id: string; number: number } | null>(null);

  // libro mayor
  const [accountId, setAccountId] = useState("");
  const [ledger, setLedger] = useState<Ledger | null>(null);

  const postable = useMemo(() => accounts.filter((a) => a.isPostable), [accounts]);

  const loadJournal = useCallback(async () => {
    const [accs, js] = await Promise.all([api.getAccounts(), api.getJournal()]);
    setAccounts(accs);
    setEntries(js);
  }, [api]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await loadJournal(); } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [loadJournal]);

  useEffect(() => {
    if (tab !== "mayor" || !accountId) { setLedger(null); return; }
    let alive = true;
    api.getLedger(accountId).then((l) => { if (alive) setLedger(l); }).catch(() => { if (alive) setLedger(null); });
    return () => { alive = false; };
  }, [tab, accountId, api]);

  async function doReverse() {
    if (!reverseTarget) return;
    try {
      await api.reverseEntry(reverseTarget.id);
      toast(`Asiento #${reverseTarget.number} reversado`, "check");
      await loadJournal();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setReverseTarget(null);
    }
  }

  if (loading) return <PageSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeading icon="book-open" title="Libro diario y mayor" subtitle="Asientos contables y movimientos por cuenta" />
        {tab === "diario" && <Button onClick={() => setModal(true)}>Nuevo asiento</Button>}
      </div>

      <div className="mb-4 max-w-sm">
        <TabBar<Tab> tabs={[{ key: "diario", label: "Libro diario" }, { key: "mayor", label: "Libro mayor" }]} active={tab} onChange={setTab} />
      </div>

      {tab === "diario" ? (
        <JournalTable entries={entries} onReverse={(id, number) => setReverseTarget({ id, number })} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="max-w-md">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Seleccione una cuenta…</option>
              {postable.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </Select>
          </div>
          {ledger ? (
            <LedgerTable data={ledger} />
          ) : (
            <p className="rounded-xl border border-dashed border-border-subtle bg-surface p-8 text-center text-[13px] text-text-tertiary">
              Elija una cuenta para ver sus movimientos.
            </p>
          )}
        </div>
      )}

      {modal && (
        <JournalEntryModal
          open={modal}
          accounts={postable}
          onClose={() => setModal(false)}
          onSaved={async () => { toast("Asiento registrado", "check"); await loadJournal(); }}
        />
      )}

      <ConfirmDialog
        open={!!reverseTarget}
        title="Reversar asiento"
        message={`Se creará un asiento espejo que anula el asiento #${reverseTarget?.number ?? ""}. El original quedará marcado como reversado. ¿Continuar?`}
        confirmLabel="Reversar"
        tone="danger"
        onConfirm={doReverse}
        onClose={() => setReverseTarget(null)}
      />
    </div>
  );
}
